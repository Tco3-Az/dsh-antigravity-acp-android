import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 48-bit TCMalloc tag constants vs 39-bit Android kernel constants
const TCMALLOC_TAG_MASK_48 = 0x1c0000000000n; // 7 << 42
const TCMALLOC_TAG_MASK_39 = 0x3800000000n;   // 7 << 35

const TCMALLOC_TAG_FREE_48 = 0x040000000000n; // 1 << 42
const TAG_BIT_35 = 0x0800000000n;             // 1 << 35

// ARM64 Syscall 439 (faccessat2) -> Syscall 48 (faccessat)
const MOV_X0_439 = 0xd2803780 >>> 0; // mov x0, #439 (80 37 80 d2)
const MOV_X0_48  = 0xd2800600 >>> 0; // mov x0, #48  (00 06 80 d2)

const MOV_X8_439 = 0xd2803748 >>> 0; // mov x8, #439 (48 37 80 d2)
const MOV_X8_48  = 0xd2800608 >>> 0; // mov x8, #48  (08 06 80 d2)

// ARM64 UBFM instructions for TCMalloc tag operations
const UBFX_42_3_MASK = 0xfffffc00 >>> 0;
const UBFX_42_3_PATTERN = 0xd36ab000 >>> 0;
const UBFX_35_3_REPLACEMENT = 0xd3639400 >>> 0;

const LSR_42_PATTERN = 0xd36abc00 >>> 0;
const LSR_35_REPLACEMENT = 0xd3639c00 >>> 0;

const LSL_42_PATTERN = 0xd3565400 >>> 0;
const LSL_35_REPLACEMENT = 0xd35d7000 >>> 0;

const AND_TAGMASK_48_PATTERN = 0x92560800 >>> 0;
const AND_TAGMASK_39_REPLACEMENT = 0x925d0800 >>> 0;

export function patchArm64Binary(buffer) {
  const sha256Before = createHash('sha256').update(buffer).digest('hex');

  let faccessat2 = 0;
  let tcmallocTagMask = 0;
  let tcmallocTagShift = 0;

  const len = buffer.length;

  // 1. Scan for 4-byte instruction patterns (4-byte aligned)
  for (let offset = 0; offset <= len - 4; offset += 4) {
    const val = buffer.readUInt32LE(offset);

    // Syscall 439 -> 48
    if (val === MOV_X0_439) {
      buffer.writeUInt32LE(MOV_X0_48, offset);
      faccessat2++;
      continue;
    }
    if (val === MOV_X8_439) {
      buffer.writeUInt32LE(MOV_X8_48, offset);
      faccessat2++;
      continue;
    }

    const masked = (val & UBFX_42_3_MASK) >>> 0;

    // TCMalloc ubfx #42, #3 -> ubfx #35, #3
    if (masked === UBFX_42_3_PATTERN) {
      const registers = val & 0x3ff;
      const newVal = (UBFX_35_3_REPLACEMENT | registers) >>> 0;
      buffer.writeUInt32LE(newVal, offset);
      tcmallocTagShift++;
      continue;
    }

    // TCMalloc lsr #42 -> lsr #35
    if (masked === LSR_42_PATTERN) {
      const registers = val & 0x3ff;
      const newVal = (LSR_35_REPLACEMENT | registers) >>> 0;
      buffer.writeUInt32LE(newVal, offset);
      tcmallocTagShift++;
      continue;
    }

    // TCMalloc lsl #42 -> lsl #35
    if (masked === LSL_42_PATTERN) {
      const registers = val & 0x3ff;
      const newVal = (LSL_35_REPLACEMENT | registers) >>> 0;
      buffer.writeUInt32LE(newVal, offset);
      tcmallocTagShift++;
      continue;
    }

    // TCMalloc and #0x1c0000000000 -> and #0x3800000000
    if (masked === AND_TAGMASK_48_PATTERN) {
      const registers = val & 0x3ff;
      const newVal = (AND_TAGMASK_39_REPLACEMENT | registers) >>> 0;
      buffer.writeUInt32LE(newVal, offset);
      tcmallocTagMask++;
      continue;
    }
  }

  // 2. Scan for 8-byte 64-bit constants (aligned to 4-byte boundaries)
  for (let offset = 0; offset <= len - 8; offset += 4) {
    const val = buffer.readBigUInt64LE(offset);
    if (val === TCMALLOC_TAG_MASK_48) {
      buffer.writeBigUInt64LE(TCMALLOC_TAG_MASK_39, offset);
      tcmallocTagMask++;
    } else if (val === TCMALLOC_TAG_FREE_48) {
      buffer.writeBigUInt64LE(TAG_BIT_35, offset);
      tcmallocTagMask++;
    }
  }

  const tcmallocTotal = tcmallocTagMask + tcmallocTagShift;
  const totalPatches = faccessat2 + tcmallocTotal;
  const sha256After = totalPatches > 0
    ? createHash('sha256').update(buffer).digest('hex')
    : sha256Before;

  return {
    patched: totalPatches > 0,
    sha256Before,
    sha256After,
    matches: {
      faccessat2,
      tcmallocTagMask,
      tcmallocTagShift,
      tcmallocTotal,
    },
    totalPatches,
  };
}

export async function patchExecutableFile(filePath) {
  const content = await readFile(filePath);
  const result = patchArm64Binary(content);
  if (result.patched) {
    await writeFile(filePath, content);
  }
  await chmod(filePath, 0o755);
  return result;
}

export async function ensurePatchedServer(options = {}) {
  const root = options.cacheDir ?? join(homedir(), '.local', 'opt', 'agy-acp', 'current');
  await mkdir(root, { recursive: true, mode: 0o755 });

  const serverBin = join(root, 'agy_acp_server.par');
  const helperBin = join(root, 'localharness_external');

  const patchResultServer = await patchExecutableFile(serverBin);
  const patchResultHelper = await patchExecutableFile(helperBin);

  await writeFile(
    join(root, '.agy-patched.json'),
    JSON.stringify({
      patchedAt: new Date().toISOString(),
      server: patchResultServer,
      helper: patchResultHelper,
    }, null, 2),
    { mode: 0o644 },
  );

  return {
    serverBin,
    helperBin,
    patchResultServer,
    patchResultHelper,
  };
}
