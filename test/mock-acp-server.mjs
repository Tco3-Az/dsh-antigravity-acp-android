import http from 'node:http';
import readline from 'node:readline';

// 1. Verify startup arguments
const argv = process.argv.slice(2);
const uidArg = argv.find((a) => a.startsWith('--uid='));
if (!uidArg) {
  console.error('Mock ACP error: Missing --uid= argument');
  process.exit(2);
}
const uidVal = uidArg.slice(6);
if (/^\d+$/.test(uidVal)) {
  console.error(`Mock ACP error: Numeric UID ${uidVal} received! PRoot forbids numeric UIDs`);
  process.exit(3);
}

// 2. Verify environment isolation
if (!process.env.NO_PROXY?.includes('127.0.0.1,localhost,::1')) {
  console.error('Mock ACP error: NO_PROXY missing 127.0.0.1,localhost,::1');
  process.exit(4);
}
if (process.env.ALL_PROXY || process.env.SOCKS_PROXY || process.env.all_proxy || process.env.socks_proxy) {
  console.error('Mock ACP error: ALL_PROXY or SOCKS_PROXY is still present in environment');
  process.exit(5);
}

// 3. Start loopback HTTP server
let callbackReceived = false;
let resolveCallback;
const callbackPromise = new Promise((resolve) => {
  resolveCallback = resolve;
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (state === 'test_state_123' && code) {
      callbackReceived = true;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Authentication successful');
      resolveCallback();
      return;
    }
  }
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('Bad Request');
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;

  // 4. Output non-JSON stdout noise to test stdout filter tolerance
  process.stdout.write('Opening in existing browser session.\n');

  // 5. Read JSON-RPC requests from stdin
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.method === 'initialize') {
        const response = {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            authMethods: [{ id: 'oauth-personal' }],
          },
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      } else if (msg.method === 'authenticate') {
        // Print OAuth URL to stderr as official agy_acp_server does
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A${port}%2Fcallback&state=test_state_123&response_type=code&client_id=mock_id`;
        process.stderr.write(`Open the following link to authenticate the ACP server: ${authUrl}\n`);

        // Wait for callback to be triggered
        await callbackPromise;

        const response = {
          jsonrpc: '2.0',
          id: msg.id,
          result: { authenticated: true },
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      console.error('Mock server JSON parse error on stdin:', e);
    }
  });
});
