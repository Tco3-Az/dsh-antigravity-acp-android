import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PatchStats {
  faccessat2: number;
  tcmallocTagMask: number;
  tcmallocTagShift: number;
  tcmallocTotal: number;
}

export interface PatchResult {
  patched: boolean;
  sha256Before: string;
  sha256After: string;
  matches: PatchStats;
  totalPatches: number;
}

export interface ByteRange {
  start: number;
  end: number;
}

// Android VA39 layout: random base bits 0..34, MemoryTag bits 35..37.
// PageId = address >> 13, so its tag occupies bits 22..24, NOT bits 29..31.
// Span's 35-bit PageId storage/checks and PageMap geometry remain unchanged.
const TAG_SHIFT = 35;
const PAGE_SHIFT = 13;
const TCMALLOC_TAG_MASK_48 = 7n << 42n;
const TCMALLOC_TAG_MASK_39 = 7n << 39n;
const TCMALLOC_TAG_MASK_35 = 7n << BigInt(TAG_SHIFT);
const TAG_BIT_42 = 1n << 42n;
const TAG_BIT_39 = 1n << 39n;
const TAG_BIT_35 = 1n << BigInt(TAG_SHIFT);
const UBFM_IMMEDIATE_MASK = (0x3f << 16) | (0x3f << 10);
const MMAP_BOUND_48 = 0xf2e00029 >>> 0;
const MMAP_BOUND_39 = 0xd3596129 >>> 0;
const AND_ADDR_47_X8 = 0x9240b908 >>> 0;
const AND_ADDR_38_X8 = 0x92409508 >>> 0;
const AND_ADDR_35_X8 = 0x92408908 >>> 0;
const AND_NOT_TAG_42_X9 = 0x9253f109 >>> 0;
const AND_NOT_TAG_39_X9 = 0x9256f109 >>> 0;
const AND_NOT_TAG_35_X9 = 0x925af109 >>> 0;

// Original Tag42 -> experimental Tag39 -> complete Tag35. The old Tag35
// MOVK sign masks were wrong; repair them separately without moving tags.
const TAG_MOVES: ReadonlyArray<readonly [number, number, number]> = [
  [0xd2c20000, 0xd2c04000, 0xd2c00400], // Tag 4 MOVZ
  [0xf2c20000, 0xf2c04000, 0xf2c00400], // Tag 4 MOVK
  [0xd2c10000, 0xd2c02000, 0xd2c00200], // Tag 2 MOVZ
  [0xf2c38000, 0xf2c07000, 0xf2c00700], // full tag-mask MOVK
  [0xd2c30000, 0xd2c06000, 0xd2c00600], // Tag 6 MOVZ
  [0xd2c08000, 0xd2c01000, 0xd2c00100], // region size limit (1 << tag shift)
  [0xf2dff400, 0xf2dff400, 0xf2c00400], // repair legacy dealloc mask
  [0xf2dff700, 0xf2dff700, 0xf2c00700],
];

// Only genuine SVC #0 / libc syscall wrappers qualify. Constants 439 and
// even the old synthetic patterns occur in JPEG/SVE loops and source locations.
const SVC_0 = 0xd4000001 >>> 0;
const MOV_X5_XZR = 0xaa1f03e5 >>> 0;
const MOV_X6_XZR = 0xaa1f03e6 >>> 0;
const BL_MASK = 0xfc000000 >>> 0;
const BL_OP = 0x94000000 >>> 0;

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);

/**
 * Locate all `google_malloc` ELF sections in the outer binary and any embedded ARM64 ELFs.
 */
export function findGoogleMallocSections(buffer: Buffer): ByteRange[] {
  const ranges: ByteRange[] = [];
  let idx = 0;
  while ((idx = buffer.indexOf(ELF_MAGIC, idx)) !== -1) {
    if (idx + 64 <= buffer.length) {
      const e_type = buffer.readUInt16LE(idx + 16);
      const e_machine = buffer.readUInt16LE(idx + 18);
      const e_shoff = Number(buffer.readBigUInt64LE(idx + 40));
      const e_shentsize = buffer.readUInt16LE(idx + 58);
      const e_shnum = buffer.readUInt16LE(idx + 60);
      const e_shstrndx = buffer.readUInt16LE(idx + 62);

      if (
        (e_type === 2 || e_type === 3) &&
        e_machine === 183 &&
        e_shoff > 0 &&
        e_shentsize >= 64 &&
        e_shnum > 0 &&
        e_shnum < 256 &&
        e_shstrndx < e_shnum &&
        idx + e_shoff + e_shentsize * e_shnum <= buffer.length
      ) {
        const shstrBase = idx + e_shoff + e_shstrndx * e_shentsize;
        const shstrOff = idx + Number(buffer.readBigUInt64LE(shstrBase + 24));
        const shstrSize = Number(buffer.readBigUInt64LE(shstrBase + 32));
        if (shstrOff > 0 && shstrOff + shstrSize <= buffer.length) {
          for (let i = 0; i < e_shnum; i++) {
            const base = idx + e_shoff + i * e_shentsize;
            const sh_name = buffer.readUInt32LE(base);
            const sh_offset = Number(buffer.readBigUInt64LE(base + 24));
            const sh_size = Number(buffer.readBigUInt64LE(base + 32));
            const nameStart = shstrOff + sh_name;
            if (nameStart < shstrOff + shstrSize) {
              const nameEnd = buffer.indexOf(0, nameStart);
              if (nameEnd !== -1 && nameEnd <= shstrOff + shstrSize) {
                const secName = buffer.subarray(nameStart, nameEnd).toString('utf8');
                if (secName === 'google_malloc' && idx + sh_offset + sh_size <= buffer.length) {
                  ranges.push({
                    start: idx + sh_offset,
                    end: idx + sh_offset + sh_size,
                  });
                }
              }
            }
          }
        }
      }
    }
    idx += 4;
  }
  return ranges;
}

/**
 * Repair TCMalloc's complete VA39 layout inside google_malloc.
 * Supports pristine Tag42, experimental Tag39, and incomplete legacy Tag35.
 * Never move generic LSR #35 or MOV #2^35: these are Span/PageMap limits.
 */
export function patchTcmallocSlice(slice: Buffer, allowRaw64BitLiterals: boolean): { maskHits: number; shiftHits: number } {
  let maskHits = 0;
  let shiftHits = 0;
  const len = slice.length;
  for (let offset = 0; offset + 4 <= len; offset += 4) {
    const val = slice.readUInt32LE(offset);
    const masked10 = (val & 0xfffffc00) >>> 0;
    const masked5 = (val & 0xffffffe0) >>> 0;
    const rd = val & 0x1f;
    if (val === MMAP_BOUND_39) continue;

    // Original W-register LSR #29 truncates to exactly three tag bits.
    // After moving tags down, LSR alone would also read address bits: UBFX
    // #22,#3 is essential. Leaving this stale routes frees to another heap,
    // corrupting the free-list bitmap and eventually Span::New's PageId.
    if (masked10 === 0x531d7c00 || masked10 === 0x531a7000 || masked10 === 0x531a7c00) {
      slice.writeUInt32LE((0x53000000 | ((TAG_SHIFT - PAGE_SHIFT) << 16) |
        ((TAG_SHIFT - PAGE_SHIFT + 2) << 10) | (val & 0x3ff)) >>> 0, offset);
      shiftHits++;
      continue;
    }

    // PageId tag mask: 7 << (42-13) -> 7 << (35-13).
    if (masked10 === 0x92630800 || masked10 === 0x92660800) {
      const targetR = 64 - (TAG_SHIFT - PAGE_SHIFT);
      slice.writeUInt32LE(((val & ~(0x3f << 16)) | (targetR << 16)) >>> 0, offset);
      maskHits++;
      // The adjacent Guarded/Tag2 comparison must move with this mask.
      for (let lookahead = 4; lookahead <= 20 && offset + lookahead + 4 <= len; lookahead += 4) {
        const next = slice.readUInt32LE(offset + lookahead);
        const op = (next & 0xffffffe0) >>> 0;
        if (op === 0x52a80000 || op === 0x52a10000) {
          slice.writeUInt32LE((0x52a01000 | (next & 31)) >>> 0, offset + lookahead);
          maskHits++;
          break;
        }
      }
      continue;
    }

    // Match exact 64-bit tag extraction/insertion pairs. Do not rewrite
    // arbitrary PageId bound checks just because their shift is 35 or 39.
    if (((val & 0xffc00000) >>> 0) === 0xd3400000) {
      const immr = (val >>> 16) & 0x3f;
      const imms = (val >>> 10) & 0x3f;
      let target: readonly [number, number] | undefined;
      if ((immr === 42 && imms === 44) || (immr === 39 && imms === 41)) {
        target = [35, 37];
      } else if ((immr === 22 && imms === 21) || (immr === 25 && imms === 24)) {
        target = [29, 28];
      }
      if (target) {
        slice.writeUInt32LE(((val & ~UBFM_IMMEDIATE_MASK) | (target[0] << 16) | (target[1] << 10)) >>> 0, offset);
        shiftHits++;
        continue;
      }
    }

    if (val === MMAP_BOUND_48) {
      slice.writeUInt32LE(MMAP_BOUND_39, offset);
      shiftHits++;
      continue;
    }
    if ((val === AND_ADDR_47_X8 || val === AND_ADDR_38_X8 || val === AND_ADDR_35_X8) && offset + 8 <= len) {
      const next = slice.readUInt32LE(offset + 4);
      if (next === AND_NOT_TAG_42_X9 || next === AND_NOT_TAG_39_X9 || next === AND_NOT_TAG_35_X9) {
        if (val !== AND_ADDR_35_X8) { slice.writeUInt32LE(AND_ADDR_35_X8, offset); maskHits++; }
        if (next !== AND_NOT_TAG_35_X9) { slice.writeUInt32LE(AND_NOT_TAG_35_X9, offset + 4); maskHits++; }
        offset += 4;
        continue;
      }
    }

    // Embedded helper (ripgrep): MOVN/MOVK materializes a 48-bit random
    // mask with old tag bits cleared. Keep its random base below bit35 too.
    // Legacy versions wrote MOVN #0; LSR #29. Those are already correct.
    if (masked5 === 0x92d38000 || masked5 === 0x92800000) {
      for (let lookahead = 4; lookahead <= 16 && offset + lookahead + 4 <= len; lookahead += 4) {
        const next = slice.readUInt32LE(offset + lookahead);
        const original = masked5 === 0x92d38000 && next === ((0xf2e00000 | rd) >>> 0);
        const prior38 = masked5 === 0x92800000 && next === ((0xd35afc00 | (rd << 5) | rd) >>> 0);
        if (original || prior38) {
          if (original) { slice.writeUInt32LE((0x92800000 | rd) >>> 0, offset); maskHits++; }
          slice.writeUInt32LE((0xd35dfc00 | (rd << 5) | rd) >>> 0, offset + lookahead);
          maskHits++;
          break;
        }
      }
      continue;
    }

    // Tag masks and sampled/cold tests. Span state flags at bits35..37 and
    // /proc/kpageflags bits44 are unrelated and MUST NOT be rewritten.
    if (masked10 === 0xf2550400 || masked10 === 0xf2580400) {
      slice.writeUInt32LE((0xf25c0400 | (val & 0x3ff)) >>> 0, offset);
      maskHits++;
      continue;
    }
    if (((val & 0xffc00000) >>> 0) === 0x92400000 && ((val >>> 10) & 63) === 2 &&
        (((val >>> 16) & 63) === 22 || ((val >>> 16) & 63) === 25)) {
      slice.writeUInt32LE(((val & ~(63 << 16)) | (29 << 16)) >>> 0, offset);
      maskHits++;
      continue;
    }
    // Only the guarded bit (shift+1) in sized-free paths, never PageFlags #44.
    if (((val & 0x7e000000) >>> 0) === 0x36000000) {
      const bit = ((val >>> 31) << 5) | ((val >>> 19) & 31);
      if (bit === 43 || bit === 40) {
        slice.writeUInt32LE(((val & ~((1 << 31) | (31 << 19))) |
          (1 << 31) | ((TAG_SHIFT + 1 - 32) << 19)) >>> 0, offset);
        shiftHits++;
        continue;
      }
    }
    for (const [original, previous, target] of TAG_MOVES) {
      if (masked5 === original || masked5 === previous) {
        slice.writeUInt32LE((target | rd) >>> 0, offset);
        maskHits++;
        break;
      }
    }
  }
  if (allowRaw64BitLiterals) {
    for (let offset = 0; offset + 8 <= len; offset += 4) {
      const val = slice.readBigUInt64LE(offset);
      if (val === TCMALLOC_TAG_MASK_48 || val === TCMALLOC_TAG_MASK_39) {
        slice.writeBigUInt64LE(TCMALLOC_TAG_MASK_35, offset); maskHits++;
      } else if (val === TAG_BIT_42 || val === TAG_BIT_39) {
        slice.writeBigUInt64LE(TAG_BIT_35, offset); maskHits++;
      }
    }
  }
  return { maskHits, shiftHits };
}

/** Patch verified ARM64 faccessat2 call sites, never bare numeric constants. */
export function patchSyscall439(buffer: Buffer): number {
  let hits = 0;
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    const val = buffer.readUInt32LE(offset);
    if ((val === 0xd28036e8 || val === 0x528036e8) && offset + 8 <= buffer.length &&
        buffer.readUInt32LE(offset + 4) === SVC_0) {
      buffer.writeUInt32LE(val === 0xd28036e8 ? 0xd2800608 : 0x52800608, offset);
      hits++;
    } else if ((val === 0xd28036e0 || val === 0x528036e0) && offset >= 8 &&
        buffer.readUInt32LE(offset - 8) === MOV_X5_XZR &&
        buffer.readUInt32LE(offset - 4) === MOV_X6_XZR && offset + 8 <= buffer.length &&
        ((buffer.readUInt32LE(offset + 4) & BL_MASK) >>> 0) === BL_OP) {
      buffer.writeUInt32LE(val === 0xd28036e0 ? 0xd2800600 : 0x52800600, offset);
      hits++;
    }
  }
  return hits;
}

/**
 * Patch an ARM64 binary buffer in memory. Scopes TCMalloc patches to `google_malloc` sections.
 */
export function patchArm64Binary(buffer: Buffer): PatchResult {
  const sha256Before = createHash('sha256').update(buffer).digest('hex');

  const faccessat2 = patchSyscall439(buffer);

  let tcmallocTagMask = 0;
  let tcmallocTagShift = 0;

  const sections = findGoogleMallocSections(buffer);
  if (sections.length > 0) {
    for (const sec of sections) {
      const slice = buffer.subarray(sec.start, sec.end);
      const { maskHits, shiftHits } = patchTcmallocSlice(slice, false);
      tcmallocTagMask += maskHits;
      tcmallocTagShift += shiftHits;
    }
  } else if (!buffer.subarray(0, 7).equals(ELF_MAGIC)) {
    // Explicit raw instruction fixture, not an unrecognized ELF layout
    const { maskHits, shiftHits } = patchTcmallocSlice(buffer, true);
    tcmallocTagMask += maskHits;
    tcmallocTagShift += shiftHits;
  }

  const tcmallocTotal = tcmallocTagMask + tcmallocTagShift;
  const totalPatches = faccessat2 + tcmallocTotal;
  const sha256After = totalPatches > 0 ? createHash('sha256').update(buffer).digest('hex') : sha256Before;

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

async function streamSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Patch an executable file on disk. Scopes large binaries (>200MB) to ELF `google_malloc` sections.
 */
export async function patchExecutableFile(filePath: string): Promise<PatchResult> {
  const fileStat = await stat(filePath);

  if (fileStat.size <= 200 * 1024 * 1024) {
    const content = await readFile(filePath);
    const result = patchArm64Binary(content);
    if (result.patched) {
      await writeFile(filePath, content);
    }
    await chmod(filePath, 0o755);
    return result;
  }

  // Large hybrid binary (e.g. 930MB agy_acp_server.par): in-place section patching
  const sha256Before = await streamSha256(filePath);
  const fh = await open(filePath, 'r+');
  let faccessat2 = 0;
  let tcmallocTagMask = 0;
  let tcmallocTagShift = 0;

  try {
    const hdr = Buffer.alloc(64);
    await fh.read(hdr, 0, 64, 0);
    if (hdr.subarray(0, 7).equals(ELF_MAGIC)) {
      const e_shoff = Number(hdr.readBigUInt64LE(40));
      const e_shentsize = hdr.readUInt16LE(58);
      const e_shnum = hdr.readUInt16LE(60);
      const e_shstrndx = hdr.readUInt16LE(62);

      if (e_shoff > 0 && e_shnum > 0 && e_shnum < 256 && e_shoff + e_shentsize * e_shnum <= fileStat.size) {
        const shTable = Buffer.alloc(e_shentsize * e_shnum);
        await fh.read(shTable, 0, shTable.length, e_shoff);

        const shstrBase = e_shstrndx * e_shentsize;
        const shstrOff = Number(shTable.readBigUInt64LE(shstrBase + 24));
        const shstrSize = Number(shTable.readBigUInt64LE(shstrBase + 32));
        const shstrTab = Buffer.alloc(shstrSize);
        await fh.read(shstrTab, 0, shstrSize, shstrOff);

        for (let i = 0; i < e_shnum; i++) {
          const base = i * e_shentsize;
          const sh_name = shTable.readUInt32LE(base);
          const sh_flags = Number(shTable.readBigUInt64LE(base + 8));
          const sh_offset = Number(shTable.readBigUInt64LE(base + 24));
          const sh_size = Number(shTable.readBigUInt64LE(base + 32));
          const nameEnd = shstrTab.indexOf(0, sh_name);
          const secName = nameEnd !== -1 ? shstrTab.subarray(sh_name, nameEnd).toString('utf8') : '';

          if (secName === 'google_malloc' && sh_size > 0 && sh_offset + sh_size <= fileStat.size) {
            const secBuf = Buffer.alloc(sh_size);
            await fh.read(secBuf, 0, sh_size, sh_offset);
            const { maskHits, shiftHits } = patchTcmallocSlice(secBuf, false);
            if (maskHits + shiftHits > 0) {
              await fh.write(secBuf, 0, sh_size, sh_offset);
              tcmallocTagMask += maskHits;
              tcmallocTagShift += shiftHits;
            }
          }
        }
      }
    }

    // Scan executable sections (first 660MB) for syscall 439
    const scanLimit = Math.min(fileStat.size, 660 * 1024 * 1024);
    const chunk = Buffer.alloc(8 * 1024 * 1024 + 16);
    let offset = 0;

    while (offset < scanLimit) {
      const toRead = Math.min(chunk.length, scanLimit - offset);
      const { bytesRead } = await fh.read(chunk, 0, toRead, offset);
      if (bytesRead === 0) break;
      const hits = patchSyscall439(chunk.subarray(0, bytesRead));
      if (hits > 0) {
        await fh.write(chunk, 0, bytesRead, offset);
        faccessat2 += hits;
      }
      offset += Math.min(8 * 1024 * 1024, bytesRead);
    }
  } finally {
    await fh.close();
  }

  await chmod(filePath, 0o755);
  const tcmallocTotal = tcmallocTagMask + tcmallocTagShift;
  const totalPatches = faccessat2 + tcmallocTotal;
  const sha256After = totalPatches > 0 ? await streamSha256(filePath) : sha256Before;

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

export interface EnsurePatchedOptions {
  cacheDir?: string;
  notify?: (msg: string) => void;
}

export async function ensurePatchedServer(options: EnsurePatchedOptions = {}): Promise<{
  serverBin: string;
  helperBin: string;
  patchResultServer: PatchResult;
  patchResultHelper: PatchResult;
}> {
  const root = options.cacheDir ?? join(homedir(), '.local', 'opt', 'agy-acp', 'current');
  await mkdir(root, { recursive: true, mode: 0o755 });

  const serverBin = join(root, 'agy_acp_server.par');
  const helperBin = join(root, 'localharness_external');

  const patchResultServer = await patchExecutableFile(serverBin);
  const patchResultHelper = await patchExecutableFile(helperBin);

  await writeFile(
    join(root, '.agy-patched.json'),
    JSON.stringify(
      {
        patchedAt: new Date().toISOString(),
        server: patchResultServer,
        helper: patchResultHelper,
      },
      null,
      2,
    ),
    { mode: 0o644 },
  );

  return {
    serverBin,
    helperBin,
    patchResultServer,
    patchResultHelper,
  };
}
