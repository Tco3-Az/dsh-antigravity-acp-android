import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

import { validateAndFormatServerArgs, prepareRunnerEnv, createStdoutJsonFilter } from '../lib/acp-runner.js';
import { AndroidOAuthManager } from '../lib/android-oauth.js';
import { unauthCardView } from '../lib/ui.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('Mock ACP Server E2E: args, environment, stdout noise tolerance, and OAuth closed loop', async (t) => {
  const mockScript = join(__dirname, 'mock-acp-server.mjs');

  // 1. Argument validation: forbid numeric UID
  assert.throws(
    () => validateAndFormatServerArgs({ args: ['--uid=1000'] }, 'agy_acp_server.par'),
    /Numeric UID is forbidden in PRoot environment/
  );

  // 2. Prepare args and environment
  const safeArgs = validateAndFormatServerArgs({ args: [] }, 'agy_acp_server.par');
  assert.deepEqual(safeArgs, ['--uid='], 'Must prepend --uid= when none provided');

  const dirtyEnv = {
    ...process.env,
    ALL_PROXY: 'socks5://127.0.0.1:1080',
    SOCKS_PROXY: 'socks5://127.0.0.1:1080',
  };
  const cleanEnv = prepareRunnerEnv(dirtyEnv, join(__dirname, '..', 'bin'));

  assert.equal(cleanEnv.ALL_PROXY, undefined, 'ALL_PROXY must be stripped');
  assert.equal(cleanEnv.SOCKS_PROXY, undefined, 'SOCKS_PROXY must be stripped');
  assert.equal(cleanEnv.NO_PROXY, '127.0.0.1,localhost,::1', 'NO_PROXY must be injected');
  assert.equal(cleanEnv.no_proxy, '127.0.0.1,localhost,::1', 'no_proxy must be injected');
  assert.equal(cleanEnv.PYTHONUNBUFFERED, '1', 'PYTHONUNBUFFERED must be 1');

  // 3. Spawn Mock ACP Server
  const child = spawn(process.execPath, [mockScript, ...safeArgs], {
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    child.kill();
  });

  // Track amStart calls
  let launchedUrl = null;
  const amStartSpy = (url) => {
    launchedUrl = url;
    return true;
  };

  const oauthManager = new AndroidOAuthManager({
    amStartLauncher: amStartSpy,
  });

  // 4. Test Stdout Filter (non-JSON noise line dropped)
  const stdoutFilter = createStdoutJsonFilter();
  child.stdout.pipe(stdoutFilter);

  const responses = [];
  const stdoutRl = readline.createInterface({ input: stdoutFilter });
  stdoutRl.on('line', (line) => {
    responses.push(JSON.parse(line));
  });

  // Wire stderr to OAuth Manager
  const stderrRl = readline.createInterface({ input: child.stderr });
  stderrRl.on('line', (line) => {
    oauthManager.handleStderrLine(line);
  });

  // Send JSON-RPC initialize
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: 1 },
  }) + '\n');

  // Wait for initialize response
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for initialize response')), 5000);
    const interval = setInterval(() => {
      const initResp = responses.find((r) => r.id === 0);
      if (initResp) {
        clearTimeout(timer);
        clearInterval(interval);
        assert.equal(initResp.result.protocolVersion, 1);
        resolve();
      }
    }, 50);
  });

  // Send JSON-RPC authenticate
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'authenticate',
    params: { methodId: 'oauth-personal' },
  }) + '\n');

  // 5. Verify OAuth URL interception and Level 1 am start launch
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (launchedUrl) {
        clearInterval(interval);
        assert.ok(launchedUrl.startsWith('https://accounts.google.com/'), 'Launched URL must be Google OAuth');
        assert.ok(Date.now() - start < 1000, 'Must intercept URL quickly');
        resolve();
      } else if (Date.now() - start > 5000) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for OAuth URL'));
      }
    }, 20);
  });

  // Verify Level 2: Native Card structure & aesthetics
  const state = oauthManager.getState();
  assert.equal(state.status, 'authorizing');
  assert.ok(state.authUrl);
  assert.ok(state.loopbackPort);
  assert.equal(state.expectedState, 'test_state_123');

  const card = unauthCardView({ lang: 'zh', authUrl: state.authUrl });
  assert.ok(card.title.length <= 16, `Card title length (${card.title.length}) must be <= 16`);
  for (const item of card.children.find((c) => c.type === 'actions').items) {
    assert.ok(item.label.length <= 10, `Button label length (${item.label.length}) must be <= 10`);
  }

  // 6. Verify Level 3: Background freeze fallback (Manual Loopback Callback Relay)
  const loopbackUrl = `http://127.0.0.1:${state.loopbackPort}/callback?state=test_state_123&code=mock_auth_code_xyz`;
  const relayResult = await oauthManager.relayLoopbackCallback(loopbackUrl);

  assert.equal(relayResult.ok, true, 'Relay fetch must succeed');
  assert.equal(relayResult.status, 200, 'Server response must be 200');

  // 7. Verify authenticate completion in JSON-RPC
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for auth completion')), 5000);
    const interval = setInterval(() => {
      const authResp = responses.find((r) => r.id === 1);
      if (authResp) {
        clearTimeout(timer);
        clearInterval(interval);
        assert.equal(authResp.result.authenticated, true);
        resolve();
      }
    }, 50);
  });
});
