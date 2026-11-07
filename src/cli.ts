#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { stat } from 'node:fs/promises';
import { patchExecutableFile } from './binary-patcher.js';

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
  },
});

const [action = 'help', targetPath] = parsed.positionals;

async function run() {
  if (parsed.values.help || action === 'help') {
    console.log(`dsh-antigravity-acp (Android Native)

Usage:
  dsh-antigravity-acp patch <binary-path>   Patch ARM64 binary (VA39 + syscall 48)
  dsh-antigravity-acp doctor                Inspect environment & runtime suitability
`);
    return;
  }

  if (action === 'patch') {
    if (!targetPath) {
      console.error('Error: specify a binary file path to patch.');
      process.exit(1);
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
    console.log(`  SHA256: ${result.sha256After}`);
    return;
  }

  if (action === 'doctor') {
    console.log('--- DSH Antigravity ACP Android Doctor ---');
    console.log(`Node.js version : ${process.version}`);
    console.log(`Architecture    : ${process.arch}`);
    console.log(`Platform        : ${process.platform}`);
    console.log(`UID             : ${process.getuid ? process.getuid() : 'N/A'}`);
    console.log(`PROOT           : ${process.env.PROOT_TMP_DIR ? 'Yes (detected)' : 'No / Host'}`);
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
