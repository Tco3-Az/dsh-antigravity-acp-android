import { basename, delimiter, join } from 'node:path';
import { Transform } from 'node:stream';

export function validateAndFormatServerArgs(config, command) {
  const userArgs = [...(config?.args ?? [])];
  const name = basename(command);
  const isLinuxAgy = ['agy_acp_server.par', 'agy_acp_server'].includes(name) || process.platform === 'linux';

  for (const arg of userArgs) {
    if (arg.startsWith('--uid=')) {
      const val = arg.slice(6);
      if (/^\d+$/.test(val)) {
        throw new Error('Numeric UID is forbidden in PRoot environment: use --uid= or --uid=$USER');
      }
    }
  }

  if (isLinuxAgy) {
    const hasUid = userArgs.some((a) => a.startsWith('--uid='));
    if (!hasUid) {
      return ['--uid=', ...userArgs];
    }
  }

  return userArgs;
}

export function prepareRunnerEnv(baseEnv = process.env, binDir) {
  const env = { ...baseEnv };

  // 1. Strip ALL_PROXY / SOCKS_PROXY
  delete env.ALL_PROXY;
  delete env.all_proxy;
  delete env.SOCKS_PROXY;
  delete env.socks_proxy;

  // 2. Force loopback bypass
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = '127.0.0.1,localhost,::1';

  // 3. Ensure unbuffered Python output
  env.PYTHONUNBUFFERED = '1';

  // 4. Inject BROWSER and PATH shims for Android
  if (binDir) {
    env.PATH = `${binDir}${delimiter}${env.PATH ?? ''}`;
    env.BROWSER = join(binDir, 'android-open-url.sh');
  }

  return env;
}

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120000;

export function createStdoutJsonFilter() {
  let pending = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'Opening in existing browser session.') {
          continue;
        }
        this.push(line + '\n');
      }
      callback();
    },
    flush(callback) {
      const trimmed = pending.trim();
      if (trimmed && trimmed !== 'Opening in existing browser session.') {
        this.push(trimmed + '\n');
      }
      callback();
    },
  });
}
