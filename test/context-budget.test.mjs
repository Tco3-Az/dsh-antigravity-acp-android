import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, isContextWindowExceededError } from '@deepseek-ai/dsh-llm';
import { ACP_CONTEXT_WINDOW, ACP_INPUT_BUDGET, ACP_OUTPUT_RESERVE, ACP_INTERNAL_RESERVE,
  estimateContextTokens, assertContextBudget } from '../lib/context.js';
import { AntigravityAcpAdapter } from '../lib/adapter.js';
import { AcpClient } from '../lib/acp/client.js';
import { ToolSessions } from '../lib/mcp/sessions.js';
import { resolveConfig } from '../lib/config.js';
import { buildPrompt } from '../lib/prompt.js';
import { RequestError } from '@agentclientprotocol/sdk';
import { classify } from '../lib/acp/errors.js';

function options(text = 'Short fixture request') {
  return { provider: 'antigravity-acp', model: 'server-default',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
}
function mustNotSpawn() {
  return { calls: 0, async resolveExecutable() { this.calls++; throw new Error('Unexpected process lookup'); },
    spawn() { this.calls++; throw new Error('Unexpected process start'); } };
}

// No network, model generation or user credentials are involved in these tests.
test('Every exact model and server-default declares decimal 256k through real DSH resolution', async (t) => {
  const ctx = new Context(), llm = new LlmRuntime(ctx), runtime = mustNotSpawn();
  const adapter = new AntigravityAcpAdapter(resolveConfig({ autoInstall: false }), runtime);
  const unregister = llm.registerAdapter(['antigravity-acp'], adapter);
  t.after(async () => { unregister(); await adapter.dispose(); });
  for (const model of ['server-default', 'fixture-one', 'fixture-future-id']) {
    const resolved = await llm.resolveModelInfo('antigravity-acp', model);
    assert.deepEqual(resolved.context, { contextWindow: 256000 });
    assert.equal(resolved.defaultMaxTokens, undefined, 'ACP does not enforce an output-token request parameter');
  }
  assert.equal(runtime.calls, 0, 'metadata lookup must not launch OAuth or a server');
});

test('Input headroom stays inside 256k and preflight uses UTF-8 rather than JS string length', () => {
  assert.equal(ACP_CONTEXT_WINDOW, 256000);
  assert.equal(ACP_INPUT_BUDGET, 232000);
  assert.equal(ACP_OUTPUT_RESERVE + ACP_INTERNAL_RESERVE + ACP_INPUT_BUDGET, ACP_CONTEXT_WINDOW);
  assert.equal(estimateContextTokens('abc'), 1);
  assert.equal(estimateContextTokens('汉'), 1);
  assert.equal(estimateContextTokens('😀'), 2);
  assertContextBudget('a'.repeat(ACP_INPUT_BUDGET * 3));
  assert.throws(() => assertContextBudget('a'.repeat(ACP_INPUT_BUDGET * 3 + 1)),
    (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED' && isContextWindowExceededError(e.message));
  assert.throws(() => assertContextBudget('汉'.repeat(ACP_INPUT_BUDGET + 1)),
    (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
});

test('Projection checks system, history and tool declarations without truncating input', () => {
  const textOnly = resolveConfig({ toolPolicy: 'text-only' });
  const request = options();
  const snapshot = structuredClone(request);
  assert.ok(buildPrompt(request, textOnly).includes('Short fixture request'));
  assert.deepEqual(request, snapshot);
  const huge = 'x'.repeat(ACP_INPUT_BUDGET * 3 + 1);
  for (const request of [options(huge), { ...options(), system: huge }])
    assert.throws(() => buildPrompt(request, textOnly), (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  const toolRequest = { ...options(), tools: [{ name: 'fixture_tool', description: huge, parameters: { type: 'object' } }] };
  assert.throws(() => buildPrompt(toolRequest, resolveConfig()), (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
});

test('Text-only and MCP routes reject over-budget history before starting a process', async (t) => {
  const huge = 'x'.repeat(ACP_INPUT_BUDGET * 3 + 1);
  for (const toolPolicy of ['text-only', 'bridge']) {
    const runtime = mustNotSpawn(), adapter = new AntigravityAcpAdapter(resolveConfig({ toolPolicy }), runtime);
    t.after(() => adapter.dispose());
    const request = toolPolicy === 'bridge' ? { ...options(huge), tools: [
      { name: 'fixture_tool', description: 'synthetic tool', parameters: { type: 'object' } },
    ] } : options(huge);
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(request)) {} },
      (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
    assert.equal(runtime.calls, 0);
  }
});

test('Official usage can lower but cannot raise the 256k session ceiling', () => {
  assertContextBudget('abc', { used: ACP_INPUT_BUDGET - 1, size: ACP_CONTEXT_WINDOW });
  assert.throws(() => assertContextBudget('abcd', { used: ACP_INPUT_BUDGET - 1, size: ACP_CONTEXT_WINDOW }),
    (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  assert.throws(() => assertContextBudget('', { used: 240000, size: 1000000 }),
    (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  assert.throws(() => assertContextBudget('', { used: 105000, size: 128000 }),
    (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  assertContextBudget('abc', { used: NaN, size: -1 });
});

test('Direct ACP prompt guard runs before transport and ignores stale state after reset', async (t) => {
  const client = new AcpClient(resolveConfig(), mustNotSpawn());
  t.after(() => client.dispose());
  assert.throws(() => client.prompt('fixture', 'x'.repeat(ACP_INPUT_BUDGET * 3 + 1)),
    (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  // This fixture exercises the same per-session map populated by usage_update.
  client.contextUsage.set('fixture', { used: 231999, size: 256000 });
  client.checkContext('fixture', 'abc');
  assert.throws(() => client.checkContext('fixture', 'abcd'), (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  await client.reset();
  client.checkContext('fixture', 'abcd');
});

test('MCP tool-result batch checks before resolving even the first parked tool promise', () => {
  const toolSessions = new ToolSessions(resolveConfig(), mustNotSpawn(), () => {});
  const call = { type: 'tool-call', id: 'fixture-call', name: 'fixture_tool', arguments: '{}' };
  let resolved = false, inspected = '';
  const binding = { sessionId: 'fixture-session', history: [], pending: new Map([[call.id, {
    call, exposed: true, resolve() { resolved = true; },
  }]]), client: { checkContext(_sessionId, text) {
    inspected = text;
    assertContextBudget(text, { used: 231999, size: 256000 });
  } } };
  const request = { ...options(), messages: [
    { role: 'assistant', content: [call] },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'tool result fixture' }] },
  ] };
  assert.throws(() => toolSessions.resume(binding, request), (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  assert.ok(inspected.includes('tool result fixture'));
  assert.equal(resolved, false);
  assert.equal(binding.pending.size, 1);
  assert.deepEqual(binding.history, []);
});

test('Prerelease real-device OAuth cold-start wait remains ten seconds in source and generated code', async () => {
  for (const path of ['../src/index.ts', '../lib/index.js']) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(text, /waitForAuthUrl\(10000\)/);
    assert.doesNotMatch(text, /waitForAuthUrl\(2500\)/);
  }
});


test('Official context overflow becomes a host-recognized error without echoing remote details', () => {
  for (const error of [
    new RequestError(-32602, 'maximum context length exceeded: fixture-private-payload'),
    new RequestError(-32000, 'Request rejected', { code: 'context_window_exceeded', detail: 'fixture-private-payload' }),
  ]) {
    const safe = classify(error);
    assert.equal(safe.code, 'CONTEXT_LENGTH_EXCEEDED');
    assert.ok(isContextWindowExceededError(safe.message));
    assert.ok(!safe.message.includes('fixture-private-payload'));
  }
  assert.equal(classify(new RequestError(-32602, 'Bad model')).code, 'ACP_INVALID_PARAMS');
});
