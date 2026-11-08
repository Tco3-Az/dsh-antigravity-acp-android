import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../lib/acp/client.js';
import { AntigravityAcpAdapter } from '../lib/adapter.js';
import { resolveConfig } from '../lib/config.js';
import { AndroidOAuthManager } from '../lib/android-oauth.js';
import { acpReasoningEffort, currentModel, modelCatalog } from '../lib/models.js';
import { connectedCardView, stripView } from '../lib/ui.js';
import { apply } from '../lib/index.js';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';

// Deliberately synthetic IDs: these are protocol fixtures, not a real catalog.
const models = [{ id: 'fixture-one', name: 'Fixture One' }, { id: 'fixture-two', name: 'Fixture Two' }];
const modern = () => ({ sessionId: 'fixture-session', configOptions: [{
  id: 'selector-id', category: 'model', name: 'Model', type: 'select',
  currentValue: models[0].id,
  options: [{ group: 'fixture-group', name: 'Group', options: models.map((m) => ({ value: m.id, name: m.name })) }],
}] });
const legacy = () => ({ sessionId: 'fixture-session', models: {
  currentModelId: models[0].id,
  availableModels: models.map((m) => ({ modelId: m.id, name: m.name })),
} });
function fixture(sessionFactory = modern, promptUsage) {
  const calls = [];
  const streams = new Set();
  let failDiscovery = false;
  let authenticationCalls = 0;
  let counter = 0;
  const runtime = {
    async resolveExecutable() { return process.execPath; },
    spawn() {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const rl = readline.createInterface({ input: stdin });
      let ended = false, resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const finish = () => {
        if (ended) return;
        ended = true; rl.close(); stdout.end(); stderr.end();
        resolveDone({ exitCode: 0, signal: null });
      };
      const handle = { stdin, stdout, stderr, done, terminate: finish,
        waitForExit: async () => { finish(); return true; } };
      streams.add(handle);
      const send = (value) => { if (!ended) stdout.write(JSON.stringify(value) + '\n'); };
      rl.on('line', (line) => {
        const msg = JSON.parse(line); calls.push(msg);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'oauth-personal', name: 'Google' }],
        } });
        if (msg.method === 'authenticate') { authenticationCalls++; return send({ jsonrpc: '2.0', id: msg.id, result: {} }); }
        if (msg.method === 'session/new') {
          if (failDiscovery) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } });
          const result = sessionFactory(); result.sessionId += '-' + (++counter);
          return send({ jsonrpc: '2.0', id: msg.id, result });
        }
        if (msg.method === 'session/set_config_option') {
          const result = sessionFactory();
          const selected = result.configOptions.find((option) => option.id === msg.params.configId);
          assert.ok(selected, 'requested selector must be announced');
          selected.currentValue = msg.params.value;
          return send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: result.configOptions } });
        }
        if (msg.method === 'session/set_model') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
        if (msg.method === 'session/prompt' && promptUsage) {
          send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: msg.params.sessionId, update: { sessionUpdate: 'usage_update', ...promptUsage },
          } });
          return;
        }
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown fixture method' } });
      });
      handle.send = send;
      return handle;
    },
  };
  return { runtime, calls, streams,
    get authenticationCalls() { return authenticationCalls; },
    fail(value) { failDiscovery = value; },
    config: resolveConfig({ command: process.execPath, autoInstall: false, toolPolicy: 'text-only',
      requestTimeoutMs: 2000, handshakeTimeoutMs: 2000, disposeGraceMs: 50 }),
  };
}

test('Model catalog reads grouped modern options and advertised legacy model state', () => {
  assert.deepEqual(modelCatalog(modern()), models);
  assert.deepEqual(modelCatalog(legacy()), models);
  assert.deepEqual(currentModel(modern()), models[0]);
  assert.deepEqual(currentModel(legacy()), models[0]);
  assert.deepEqual(modelCatalog({ sessionId: 's' }), []);
  const both = { ...legacy(), ...modern() };
  assert.deepEqual(modelCatalog(both), models);
  const malformed = { sessionId: 's', models: { currentModelId: '', availableModels: [{ modelId: '', name: 'bad' }] } };
  assert.deepEqual(modelCatalog(malformed), []);
});

for (const [label, factory, method] of [
  ['modern configOptions', modern, 'session/set_config_option'],
  ['legacy model extension', legacy, 'session/set_model'],
]) {
  test(`Already signed in: discover and switch using ${label}, without another login`, async (t) => {
    const f = fixture(factory), oauth = new AndroidOAuthManager(); oauth.markAuthenticated();
    const client = new AcpClient(f.config, f.runtime, () => {}, oauth);
    t.after(() => client.dispose());
    const session = await client.newSession(undefined, false);
    assert.deepEqual(modelCatalog(session), models, 'wire metadata must survive SDK transport');
    await client.selectModel(session, 'fixture-two');
    const call = f.calls.find((m) => m.method === method);
    assert.ok(call, 'use the method announced by this session');
    assert.equal(method === 'session/set_model' ? call.params.modelId : call.params.value, 'fixture-two');
    assert.equal(currentModel(session)?.id, 'fixture-two');
    assert.equal(f.authenticationCalls, 0, 'model discovery must not launch another OAuth flow');
    const before = f.calls.length;
    await client.selectModel(session, 'fixture-two');
    await client.selectModel(session, 'server-default');
    assert.equal(f.calls.length, before, 'same model and default alias must be no-ops');
    await assert.rejects(client.selectModel(session, 'not-announced'), (e) => e.code === 'ACP_INVALID_MODEL');
  });
}

test('Config notifications update a live session and model display', async (t) => {
  const f = fixture(), client = new AcpClient(f.config, f.runtime);
  t.after(() => client.dispose());
  const session = await client.newSession(undefined, false);
  let observed;
  client.onSessionState = (s) => { observed = currentModel(s); };
  const configOptions = modern().configOptions;
  configOptions[0].currentValue = 'fixture-two';
  [...f.streams][0].send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: session.sessionId, update: { sessionUpdate: 'config_option_update', configOptions },
  } });
  for (let i = 0; i < 30 && !observed; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(observed, models[1]);
});

test('Discovery retries after pre-login failure and preserves the GUI default alias after login', async (t) => {
  const f = fixture(legacy), oauth = new AndroidOAuthManager();
  const adapter = new AntigravityAcpAdapter(f.config, f.runtime, () => {}, oauth);
  t.after(() => adapter.dispose());
  f.fail(true);
  assert.deepEqual((await adapter.listModels(f.config.provider)).map((m) => m.id), ['server-default']);
  assert.equal(adapter.modelState().discoveryError, 'ACP_AUTH_REQUIRED');
  f.fail(false); oauth.markAuthenticated();
  const list = await adapter.refreshModels();
  assert.deepEqual(list.map((m) => m.id), ['fixture-one', 'fixture-two', 'server-default']);
  assert.equal(adapter.modelState().currentModel.name, 'Fixture One');
  assert.equal(adapter.modelState().discoveryError, undefined);
  assert.equal(f.authenticationCalls, 0);
  assert.equal((await adapter.resolveModel(f.config.provider, 'server-default')).id, 'server-default');
});

test('No invented quota or reset period; signed-in does not imply a running request', () => {
  const text = JSON.stringify(connectedCardView({ lang: 'zh' }));
  assert.ok(!text.includes('100%')); assert.ok(!text.includes('每日重置')); assert.ok(!text.includes('server-default'));
  assert.ok(text.includes('服务端未提供')); assert.ok(text.includes('refresh-models'));
  const exact = JSON.stringify(connectedCardView({ lang: 'en', model: 'Fixture One', quotaPercent: 0, resetTime: 'Reported reset' }));
  assert.ok(exact.includes('0%')); assert.ok(exact.includes('Reported reset'));
  assert.equal(stripView({ authorized: true }, 'zh').text, 'Antigravity 已登录');
});

test('Plugin emits model catalog changes and panel reflects live selection instead of static config', async (t) => {
  const f = fixture(legacy), events = [], disposers = [];
  let adapter, panel;
  const dshGo = { strip() {}, panel(_id, value) { panel = value; }, refresh() {} };
  const ctx = { subprocess: f.runtime, logger: { warn() {} },
    llm: { registerAdapter(_routes, value) { adapter = value; return () => {}; } },
    effect(cb) { disposers.push(cb()); },
    inject(_names, cb) { cb({ dshGo }); }, emit(...args) { events.push(args); },
  };
  await apply(ctx, { command: process.execPath, autoInstall: false, toolPolicy: 'text-only' });
  t.after(async () => { for (const dispose of disposers) await dispose(); });
  await adapter.listModels('antigravity-acp');
  const view = panel.view({}, { locale: 'zh' });
  assert.ok(JSON.stringify(view).includes('Fixture One'));
  assert.ok(!JSON.stringify(view).includes('100%'));
  assert.ok(events.some(([name, provider]) => name === 'llm/models-updated' && provider === 'antigravity-acp'));
  const deferred = panel.actions['refresh-models']({}, { locale: 'zh' });
  assert.equal(deferred.pending.timeoutMs, 60000);
  const result = await deferred.result(new AbortController().signal);
  assert.equal(result.type, 'toast'); assert.equal(result.text, '模型已刷新');
});

function withReasoning() {
  const result = modern();
  result.configOptions.push({ id: 'thinking-selector', category: 'thought_level', name: 'Thinking',
    type: 'select', currentValue: 'low',
    options: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, name: value })),
  });
  return result;
}

test('xhigh and max always map to high, even when the server advertises higher levels', async (t) => {
  assert.equal(acpReasoningEffort('xhigh'), 'high');
  assert.equal(acpReasoningEffort('max'), 'high');
  assert.equal(acpReasoningEffort('high'), 'high');
  assert.equal(acpReasoningEffort('low'), 'low');
  assert.equal(acpReasoningEffort(), undefined);
  const f = fixture(withReasoning), client = new AcpClient(f.config, f.runtime);
  t.after(() => client.dispose());
  for (const effort of ['xhigh', 'max', 'high']) {
    const session = await client.newSession(undefined, false);
    await client.selectReasoning(session, effort);
    const call = f.calls.findLast((m) => m.method === 'session/set_config_option');
    assert.deepEqual(call.params, { sessionId: session.sessionId, configId: 'thinking-selector', value: 'high' });
    assert.equal(session.configOptions.find((o) => o.id === 'thinking-selector').currentValue, 'high');
    const before = f.calls.length;
    await client.selectReasoning(session, 'max');
    assert.equal(f.calls.length, before, 'already-high state must avoid another RPC');
  }
  const session = await client.newSession(undefined, false);
  await client.selectReasoning(session, 'off');
  assert.equal(f.calls.findLast((m) => m.method === 'session/set_config_option').params.value, 'none');
  await assert.rejects(client.selectReasoning(session, 'unsupported'), (e) => e.code === 'ACP_INVALID_REASONING');
});

test('Legacy model-tier sessions do not receive invented thought selectors', async (t) => {
  const f = fixture(legacy), client = new AcpClient(f.config, f.runtime);
  t.after(() => client.dispose());
  const session = await client.newSession(undefined, false), before = f.calls.length;
  await client.selectReasoning(session, 'xhigh');
  await client.selectReasoning(session, 'max');
  assert.equal(f.calls.length, before);
});

test('Real DSH host accepts xhigh and max before ACP dispatch', async (t) => {
  const f = fixture(), ctx = new Context(), llm = new LlmRuntime(ctx);
  const adapter = new AntigravityAcpAdapter(f.config, f.runtime, () => {});
  const unregister = llm.registerAdapter([f.config.provider], adapter);
  t.after(async () => { unregister(); await adapter.dispose(); });
  for (const reasoningEffort of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const requested = { provider: f.config.provider, model: 'server-default', reasoningEffort };
    await assert.doesNotReject(llm.resolveCallConfig(requested));
  }
});

test('Cancelled model refresh stops before issuing another server request', async (t) => {
  const f = fixture(), adapter = new AntigravityAcpAdapter(f.config, f.runtime, () => {});
  t.after(() => adapter.dispose());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.refreshModels(controller.signal), (e) => e.code === 'ABORTED');
  assert.equal(f.calls.length, 0);
});

const nativeHostUrl = new URL('../../dsh-go-repo/sdk/plugin-kit/lib/testing.js', import.meta.url);
test('Native plugin host validates signed-in panel actions and deferred refresh', {
  skip: !existsSync(fileURLToPath(nativeHostUrl)),
}, async (t) => {
  const { createTestHost } = await import(nativeHostUrl.href);
  const host = createTestHost({ dir: process.cwd() }), f = fixture(legacy);
  let adapter;
  host.ctx.llm = { registerAdapter(_providers, value) { adapter = value; return () => {}; } };
  host.ctx.subprocess = f.runtime;
  await apply(host.ctx, { command: process.execPath, autoInstall: false, toolPolicy: 'text-only' });
  t.after(async () => { host.dispose(); await adapter.dispose(); });
  await adapter.listModels('antigravity-acp');
  const panel = await host.view('acp-panel', {}, { locale: 'zh-CN' });
  assert.ok(JSON.stringify(panel.view).includes('Fixture One'));
  const action = panel.view.children.find((child) => child.type === 'actions').items[0];
  assert.deepEqual(action.action, { id: 'refresh-models' });
  const refresh = await host.invoke('acp-panel', { action: 'refresh-models' });
  assert.ok(refresh.pending, 'slow discovery must not run inside the native 3s action deadline');
  const settled = await refresh.settled;
  assert.equal(settled.t, 'done');
  assert.deepEqual(host.violations, []);
});


test('Live usage_update feeds the session budget; it is not emitted as billing usage', async (t) => {
  const f = fixture(), client = new AcpClient(f.config, f.runtime);
  t.after(() => client.dispose());
  const session = await client.newSession(undefined, false);
  const usage = new Promise((resolve) => { client.onUpdate = () => resolve(); });
  [...f.streams][0].send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: session.sessionId, update: { sessionUpdate: 'usage_update', used: 231999, size: 256000 },
  } });
  await usage;
  assert.throws(() => client.checkContext(session.sessionId, 'four'), (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
  client.checkContext(session.sessionId, 'one');
});

test('Text and MCP streams cancel gracefully when official context occupancy crosses safe headroom', async (t) => {
  for (const toolPolicy of ['text-only', 'bridge']) {
    const f = fixture(modern, { used: 240000, size: 1000000 });
    const spawn = f.runtime.spawn.bind(f.runtime);
    f.runtime.spawn = (...args) => {
      const handle = spawn(...args);
      // Intercept only the fixture initialize result to advertise MCP support.
      const write = handle.stdout.write.bind(handle.stdout);
      handle.stdout.write = (chunk, ...rest) => {
        const packet = JSON.parse(String(chunk));
        if (packet.result?.protocolVersion === 1) packet.result.agentCapabilities = { mcpCapabilities: { http: true } };
        return write(JSON.stringify(packet) + '\n', ...rest);
      };
      return handle;
    };
    const adapter = new AntigravityAcpAdapter({ ...f.config, toolPolicy }, f.runtime, () => {});
    t.after(() => adapter.dispose());
    const chunks = [];
    const request = { provider: f.config.provider, model: 'server-default',
      signal: AbortSignal.timeout(3000),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic fixture' }] }],
      ...(toolPolicy === 'bridge' ? { tools: [{ name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } }] } : {}),
    };
    await assert.rejects(async () => { for await (const chunk of adapter.stream(request)) chunks.push(chunk); },
      (e) => e.code === 'CONTEXT_LENGTH_EXCEEDED');
    assert.ok(f.calls.some((c) => c.method === 'session/cancel'));
    assert.ok(!chunks.some((c) => c.type === 'usage'));
  }
});
