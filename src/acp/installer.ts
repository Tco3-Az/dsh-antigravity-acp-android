import { createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import * as yauzl from 'yauzl';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { aborted } from './errors.js';
import { patchExecutableFile } from '../binary-patcher.js';

export const SERVER_VERSION = '1.3.0';

export function distribution(platform = process.platform as string, arch = process.arch as string) {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform];
  const cpu = { x64: 'x86_64', arm64: 'arm64' }[arch];
  if (!os || !cpu)
    throw new LlmError(
      'Automatic Antigravity installation is unsupported on this OS/architecture.',
      'ACP_PLATFORM_UNSUPPORTED',
    );
  const label = platform === 'darwin' ? 'darwin' : os;
  return {
    key: `${platform}-${arch}`,
    command: platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
    url: `https://dl.google.com/agy-extensions/releases/${os}/agy-acp-server-${SERVER_VERSION}-${label}-${cpu}.zip`,
  };
}

export interface InstallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  notify?: (message: string) => void;
  cacheRoot?: string;
  platform?: string;
  arch?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

function safeName(name: string): boolean {
  return (
    !!name &&
    !/[\\:\x00-\x1f]/.test(name) &&
    !name.startsWith('/') &&
    name
      .replace(/\/$/, '')
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

type FileRecord = { name: string; size: number };

async function publicationLock(path: string, signal: AbortSignal): Promise<() => Promise<void>> {
  for (;;) {
    signal.throwIfAborted();
    try {
      await writeFile(path, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              await unlink(path);
              continue;
            }
          }
        } else if (Date.now() - (await lstat(path)).mtimeMs > 5000) {
          await unlink(path);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(50, undefined, { signal });
    }
  }
}

async function ready(directory: string, command: string): Promise<boolean> {
  try {
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
      return false;
    const receiptPath = join(directory, '.dsh-ready.json');
    const stat = await lstat(receiptPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (
      receipt.version !== SERVER_VERSION ||
      !Array.isArray(receipt.files) ||
      !receipt.files.some((file: FileRecord) => file.name === command && file.size > 0)
    )
      return false;
    for (const file of receipt.files as FileRecord[]) {
      if (typeof file.name !== 'string' || !safeName(file.name)) return false;
      const stat = await lstat(join(directory, file.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function unpack(
  archive: string,
  directory: string,
  signal: AbortSignal,
): Promise<FileRecord[]> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => (error ? reject(error) : resolve(zip!)),
    ),
  );
  const files: FileRecord[] = [];
  let expanded = 0;
  let processing: Promise<void> | undefined;
  let onAbort: (() => void) | undefined;
  const failed = new AbortController();
  signal = AbortSignal.any([signal, failed.signal]);
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = (onAbort = () => {
        zip.close();
        reject(Error('cancelled'));
      });
      signal.addEventListener('abort', stop, { once: true });
      zip.once('error', reject);
      zip.once('end', () => {
        signal.removeEventListener('abort', stop);
        resolve();
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        processing = (async () => {
          signal.throwIfAborted();
          const mode = entry.externalFileAttributes >>> 16,
            kind = mode & 0o170000;
          if (
            !safeName(entry.fileName) ||
            (kind && kind !== 0o100000 && kind !== 0o040000) ||
            entry.isEncrypted() ||
            zip.entriesRead > 4096
          )
            throw Error('unsafe archive entry');
          const path = join(directory, entry.fileName);
          if (entry.fileName.endsWith('/')) await mkdir(path, { recursive: true, mode: 0o700 });
          else {
            expanded += entry.uncompressedSize;
            if (expanded > 1024 * 1024 * 1024) throw Error('archive too large');
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            const stream = await new Promise<Readable>((resolve, reject) =>
              zip.openReadStream(entry, (error, stream) =>
                error ? reject(error) : resolve(stream),
              ),
            );
            await pipeline(
              stream,
              createWriteStream(path, { flags: 'wx', mode: mode & 0o111 ? 0o755 : 0o644 }),
              { signal },
            );
            files.push({ name: entry.fileName, size: entry.uncompressedSize });
          }
          zip.readEntry();
        })();
        void processing.catch(reject);
      });
      if (signal.aborted) stop();
      else zip.readEntry();
    });
    return files;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    failed.abort();
    await processing?.catch(() => {});
    zip.close();
  }
}

export async function ensureOfficialServer(options: InstallOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const artifact = distribution(options.platform, options.arch);
  const root = resolve(
    options.cacheRoot ??
      (process.env.DSH_HOME
        ? join(process.env.DSH_HOME, 'cache', 'antigravity-acp')
        : join(homedir(), '.local', 'opt', 'agy-acp', 'current')),
  );
  const directory = join(root, `${SERVER_VERSION}-${artifact.key}`);
  if (await ready(directory, artifact.command)) return join(directory, artifact.command);
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 180000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let stage: string | undefined;
  try {
    signal.throwIfAborted();
    await mkdir(root, { recursive: true, mode: 0o755 });
    stage = await mkdtemp(join(root, '.install-'));
    const archive = join(stage, 'download.zip'),
      payload = join(stage, 'payload');
    options.notify?.(
      'Preparing official Antigravity server automatically. The first download may take a few minutes.',
    );
    const response = await (options.fetch ?? globalThis.fetch)(artifact.url, {
      signal,
      redirect: 'error',
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get('content-length') ?? 0) > 512 * 1024 * 1024
    )
      throw Error('download failed');
    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > 512 * 1024 * 1024 ? Error('download too large') : null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      limit,
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    await mkdir(payload, { mode: 0o755 });
    const files = await unpack(archive, payload, signal);
    if (!files.some((file) => file.name === artifact.command && file.size > 0))
      throw Error('missing server');

    // ARM64 Linux / PRoot Android Binary Patching (TCMalloc VA39 + Syscall 439 faccessat2)
    const serverPath = join(payload, artifact.command);
    const helperPath = join(payload, 'localharness_external');

    try {
      await patchExecutableFile(serverPath);
      await chmod(serverPath, 0o755);
    } catch {
      // Continue if non-ELF
    }

    try {
      await patchExecutableFile(helperPath);
      await chmod(helperPath, 0o755);
    } catch {
      // Helper might be optional on some platforms
    }

    // Refresh file records with post-patch file sizes
    const updatedFiles: FileRecord[] = [];
    for (const file of files) {
      const s = await lstat(join(payload, file.name));
      updatedFiles.push({ name: file.name, size: s.size });
    }

    await writeFile(
      join(payload, '.dsh-ready.json'),
      JSON.stringify({ version: SERVER_VERSION, files: updatedFiles }),
      { flag: 'wx', mode: 0o644 },
    );
    signal.throwIfAborted();

    const unlock = await publicationLock(`${directory}.lock`, signal);
    try {
      if (!(await ready(directory, artifact.command))) {
        try {
          await rename(directory, join(stage, 'obsolete'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rename(payload, directory);
      }
    } finally {
      await unlock();
    }
    if (!(await ready(directory, artifact.command))) throw Error('invalid cache');
    options.notify?.('Official Antigravity server is ready.');
    return join(directory, artifact.command);
  } catch {
    if (options.signal?.aborted) throw aborted();
    throw new LlmError(
      'Automatic official Antigravity download failed. Check internet access and free disk space, then retry in DSH.',
      'ACP_INSTALL_FAILED',
    );
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
