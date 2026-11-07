import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DEFAULT_BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin');

const ANDROID_CA_CANDIDATES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/data/data/com.termux/files/usr/etc/tls/cert.pem',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
];

export interface RunnerConfig {
  args?: string[];
  env?: Record<string, string | undefined>;
  handshakeTimeoutMs?: number;
  command?: string;
}

export function validateAndFormatServerArgs(config: RunnerConfig, command: string): string[] {
  const userArgs = [...(config.args ?? [])];
  const name = basename(command);
  const isLinuxAgy =
    ['agy_acp_server.par', 'agy_acp_server'].includes(name) || process.platform === 'linux';

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

/**
 * Ensure the dlopen memfd interceptor shim is compiled if running on Linux PRoot.
 */
export function ensureDlopenShim(binDir: string): string | undefined {
  if (process.platform !== 'linux') return undefined;

  const shimSo = join(binDir, 'dlopen-shim.so');
  if (existsSync(shimSo)) return shimSo;

  const shimC = join(binDir, 'dlopen-shim.c');
  if (!existsSync(shimC)) return undefined;

  // Attempt compilation via gcc or clang
  try {
    execSync(`gcc -shared -fPIC -O2 -o "${shimSo}" "${shimC}" -ldl 2>/dev/null || clang -shared -fPIC -O2 -o "${shimSo}" "${shimC}" -ldl 2>/dev/null`, {
      stdio: 'ignore',
      timeout: 10000,
    });
    if (existsSync(shimSo)) return shimSo;
  } catch {
    // Compiler not present; continue without crashing
  }

  return undefined;
}

export function prepareRunnerEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  binDir: string = DEFAULT_BIN_DIR,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  // 1. Strip ALL_PROXY / SOCKS_PROXY to prevent SOCKS crashes and loopback hijacking
  delete env.ALL_PROXY;
  delete env.all_proxy;
  delete env.SOCKS_PROXY;
  delete env.socks_proxy;

  // 2. Strip Termux Bionic LD_PRELOAD to prevent glibc symbol clash ("version LIBC not found")
  if (env.LD_PRELOAD && env.LD_PRELOAD.includes('libtermux-exec')) {
    const parts = env.LD_PRELOAD.split(':').filter((p) => !p.includes('libtermux-exec'));
    if (parts.length > 0) {
      env.LD_PRELOAD = parts.join(':');
    } else {
      delete env.LD_PRELOAD;
    }
  }

  // 3. Inject dlopen-shim.so to bypass PRoot memfd /proc/self/fd/N EACCES on Linux
  if (process.platform === 'linux' && binDir) {
    const shimSo = ensureDlopenShim(binDir);
    if (shimSo && existsSync(shimSo)) {
      const existing = env.LD_PRELOAD ? env.LD_PRELOAD.split(':') : [];
      if (!existing.includes(shimSo)) {
        env.LD_PRELOAD = [shimSo, ...existing].join(':');
      }
    }
  }

  // 4. Force loopback bypass via NO_PROXY
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = '127.0.0.1,localhost,::1';

  // 5. Ensure unbuffered Python output and disable background auto-updater overwriting VA39 patch
  env.PYTHONUNBUFFERED = '1';
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';

  // 6. Force pure Go DNS resolver for Android/PRoot compatibility
  if (!env.GODEBUG) {
    env.GODEBUG = 'netdns=go';
  } else if (!env.GODEBUG.includes('netdns=')) {
    env.GODEBUG = `${env.GODEBUG},netdns=go`;
  }

  // 7. Ensure SSL_CERT_FILE is set if a known CA bundle exists (fixes Go x509 token exchange on Android)
  if (!env.SSL_CERT_FILE) {
    const foundCa = ANDROID_CA_CANDIDATES.find((p) => existsSync(p));
    if (foundCa) {
      env.SSL_CERT_FILE = foundCa;
    }
  }

  // 8. Inject BROWSER and PATH shims for Android
  if (binDir) {
    env.PATH = `${binDir}${delimiter}${env.PATH ?? ''}`;
    env.BROWSER = join(binDir, 'android-open-url.sh');
  }

  return env;
}

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120000;

export function createStdoutJsonFilter(): Transform {
  let pending = '';
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'Opening in existing browser session.') {
          // Drop non-JSON browser session noise from stdout
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
