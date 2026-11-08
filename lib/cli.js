#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { patchExecutableFile, ensurePatchedServer } from './binary-patcher.js';
const execFileAsync = promisify(execFile);
const parsed = parseArgs({
    allowPositionals: true,
    options: {
        help: { type: 'boolean', short: 'h' },
        dir: { type: 'string' },
        platform: { type: 'string' },
        arch: { type: 'string' },
    },
});
const [action = 'help', targetPath] = parsed.positionals;
async function fallbackDownloadAndPatch(cacheRoot, platform, arch) {
    const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform] ?? 'linux';
    const cpu = { x64: 'x86_64', arm64: 'arm64' }[arch] ?? 'arm64';
    const label = platform === 'darwin' ? 'darwin' : os;
    const version = '1.3.0';
    const url = `https://dl.google.com/agy-extensions/releases/${os}/agy-acp-server-${version}-${label}-${cpu}.zip`;
    await mkdir(cacheRoot, { recursive: true, mode: 0o755 });
    const zipPath = join(cacheRoot, 'agy-acp-server.zip');
    console.log(`[installer] Downloading ${url}...`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`Download failed with HTTP ${res.status}`);
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
    console.log(`[installer] Extracting archive to ${cacheRoot}...`);
    try {
        await execFileAsync('unzip', ['-o', zipPath, '-d', cacheRoot]);
    }
    catch {
        await execFileAsync('python3', ['-m', 'zipfile', '-e', zipPath, cacheRoot]);
    }
    await rm(zipPath, { force: true });
    console.log('[installer] Applying ARM64 VA39 + faccessat2 binary patches...');
    return ensurePatchedServer({ cacheDir: cacheRoot });
}
function detectProot() {
    if (process.env.PROOT_TMP_DIR)
        return { isProot: true, reason: 'PROOT_TMP_DIR env' };
    if (process.env.PROOT_LOADER)
        return { isProot: true, reason: 'PROOT_LOADER env' };
    try {
        if (process.platform === 'linux') {
            const maps = readFileSync('/proc/self/maps', 'utf8');
            if (maps.includes('libproot.so') || maps.includes('proot')) {
                return { isProot: true, reason: 'libproot in /proc/self/maps' };
            }
        }
    }
    catch { }
    return { isProot: false, reason: 'No PRoot signatures found' };
}
function detectVaBits() {
    if (process.platform !== 'linux')
        return 48;
    try {
        const maps = readFileSync('/proc/self/maps', 'utf8');
        let maxAddr = 0n;
        for (const line of maps.split('\n')) {
            const match = line.match(/^[0-9a-f]+-([0-9a-f]+)\s/);
            if (match) {
                const end = BigInt('0x' + match[1]);
                if (end > maxAddr)
                    maxAddr = end;
            }
        }
        if (maxAddr > 0n) {
            return maxAddr.toString(2).length;
        }
    }
    catch { }
    return 48;
}
async function run() {
    if (parsed.values.help || action === 'help') {
        console.log(`dsh-antigravity-acp (Android Native)

Usage:
  dsh-antigravity-acp setup [--dir <path>]  Download, extract & patch official linux-arm64 ACP server
  dsh-antigravity-acp patch [binary-path]   Patch ARM64 binary in-place (VA39 + syscall 48)
  dsh-antigravity-acp doctor                Inspect environment & runtime suitability
`);
        return;
    }
    if (action === 'setup' || action === 'install') {
        const cacheRoot = parsed.values.dir ?? join(homedir(), '.local', 'opt', 'agy-acp', 'current');
        const platform = parsed.values.platform ?? (process.platform === 'win32' ? 'linux' : process.platform);
        const arch = parsed.values.arch ?? (process.arch === 'x64' ? 'arm64' : process.arch);
        console.log(`Ensuring official Antigravity ACP server (${platform}-${arch}) in ${cacheRoot}...`);
        try {
            const { ensureOfficialServer } = await import('./acp/installer.js');
            const serverBin = await ensureOfficialServer({
                cacheRoot,
                platform,
                arch,
                notify: (msg) => console.log(`[installer] ${msg}`),
            });
            console.log(`Server ready and patched at: ${serverBin}`);
        }
        catch {
            const res = await fallbackDownloadAndPatch(cacheRoot, platform, arch);
            console.log(`Server ready and patched at: ${res.serverBin}`);
        }
        return;
    }
    if (action === 'patch') {
        if (!targetPath) {
            const cacheRoot = parsed.values.dir ?? join(homedir(), '.local', 'opt', 'agy-acp', 'current');
            console.log(`Patching server and helper in ${cacheRoot}...`);
            const res = await ensurePatchedServer({ cacheDir: cacheRoot });
            console.log('Server patch result:', res.patchResultServer);
            console.log('Helper patch result:', res.patchResultHelper);
            return;
        }
        const s = await stat(targetPath).catch(() => null);
        if (!s || !s.isFile()) {
            console.error(`Error: file not found: ${targetPath}`);
            process.exit(1);
        }
        console.log(`Patching ${targetPath}...`);
        const result = await patchExecutableFile(targetPath);
        console.log(`Patch status: ${result.patched ? 'Patched' : 'Already patched / No matches needed'}`);
        console.log(`  faccessat2 (439 -> 48): ${result.matches.faccessat2}`);
        console.log(`  TCMalloc VA39 masks:   ${result.matches.tcmallocTagMask}`);
        console.log(`  TCMalloc VA39 shifts:  ${result.matches.tcmallocTagShift}`);
        console.log(`  Total patches:         ${result.totalPatches}`);
        console.log(`  SHA256 Before: ${result.sha256Before}`);
        console.log(`  SHA256 After:  ${result.sha256After}`);
        return;
    }
    if (action === 'doctor') {
        const prootInfo = detectProot();
        const vaBits = detectVaBits();
        console.log('--- DSH Antigravity ACP Android Doctor ---');
        console.log(`Node.js version : ${process.version}`);
        console.log(`Architecture    : ${process.arch}`);
        console.log(`Platform        : ${process.platform}`);
        console.log(`UID             : ${process.getuid ? process.getuid() : 'N/A'}`);
        console.log(`PROOT           : ${prootInfo.isProot ? `Yes (${prootInfo.reason})` : 'No / Host'}`);
        console.log(`Address Space   : ~${vaBits} bits (${vaBits <= 39 ? 'Android 39-bit VA space detected' : 'Standard 48-bit VA space'})`);
        console.log(`NO_PROXY env    : ${process.env.NO_PROXY || 'not set'}`);
        console.log('------------------------------------------');
        return;
    }
    console.error(`Unknown command: ${action}. Use --help.`);
    process.exit(1);
}
run().catch((err) => {
    console.error(err);
    process.exit(1);
});
