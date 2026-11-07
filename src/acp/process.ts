import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { Config } from '../config.js';
import { ensureOfficialServer } from './installer.js';
import { validateAndFormatServerArgs } from '../acp-runner.js';
import { patchExecutableFile } from '../binary-patcher.js';

const patchedCache = new Set<string>();

async function ensurePatchedOnArm64Linux(resolvedCommand: string): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'arm64') return;
  if (patchedCache.has(resolvedCommand)) return;
  try {
    await patchExecutableFile(resolvedCommand);
  } catch {
    // Non-ELF or read-only script wrapper; ignore
  }
  try {
    const companion = join(dirname(resolvedCommand), 'localharness_external');
    await patchExecutableFile(companion);
  } catch {
    // Companion binary optional
  }
  patchedCache.add(resolvedCommand);
}

export async function resolveCommand(
  config: Config,
  runtime: SubprocessRuntime,
  signal?: AbortSignal,
  notify?: (message: string) => void,
): Promise<string> {
  const explicit = config.command || process.env.AGY_ACP_BIN;
  const names =
    process.platform === 'win32'
      ? ['agy_acp_server.exe']
      : ['agy_acp_server.par', 'agy_acp_server'];
  const candidates = explicit
    ? [explicit]
    : [
        ...names,
        ...names.map((n) => join(homedir(), '.local', 'opt', 'agy-acp', 'current', n)),
        ...names.map((n) => join(homedir(), '.local', 'bin', n)),
        ...names.map((n) => join(homedir(), '.local', 'share', 'antigravity-acp', n)),
      ];
  for (const command of candidates) {
    signal?.throwIfAborted();
    try {
      const resolved = await runtime.resolveExecutable(command, undefined, signal);
      await ensurePatchedOnArm64Linux(resolved);
      return resolved;
    } catch {
      signal?.throwIfAborted();
    }
  }
  // An explicit override is authoritative: never hide a typo by downloading.
  if (!explicit && config.autoInstall) {
    const command = await ensureOfficialServer({
      signal,
      timeoutMs: config.installTimeoutMs,
      notify,
    });
    const resolved = await runtime.resolveExecutable(command, undefined, signal);
    await ensurePatchedOnArm64Linux(resolved);
    return resolved;
  }
  throw new LlmError(
    'Official Antigravity ACP binary was not found. Remove an invalid command override or enable automatic installation, then retry in DSH.',
    'ACP_BINARY_MISSING',
  );
}

export function serverArgs(config: Config, command: string): string[] {
  return validateAndFormatServerArgs(config, command);
}

export async function disposeProcess(child: SubprocessHandle, graceMs: number): Promise<void> {
  child.stdin?.end();
  let exited = false;
  try {
    exited = await child.waitForExit(AbortSignal.timeout(graceMs));
  } finally {
    if (!exited) {
      child.terminate();
      await child.waitForExit();
    }
  }
}
