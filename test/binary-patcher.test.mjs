import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { patchArm64Binary, patchExecutableFile } from '../lib/binary-patcher.js';

test('ARM64 binary patcher synthetic ELF test', () => {
  // 1. Construct synthetic ELF Buffer
  const buf = Buffer.alloc(4096);

  // ELF Header magic
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]).copy(buf, 0);

  // Fill with dummy instructions (e.g. nop 0xd503201f, ret 0xd65f03c0)
  for (let i = 16; i < 4096; i += 4) {
    buf.writeUInt32LE(i % 8 === 0 ? 0xd503201f : 0xd65f03c0, i);
  }

  // Plant target patterns at known offsets:
  // Offset 0x100: canonical mov x0, #439 (0xd28036e0)
  const offsetMovX0Canonical = 0x100;
  buf.writeUInt32LE(0xd28036e0 >>> 0, offsetMovX0Canonical);

  // Offset 0x120: prompt literal mov x0, #439 (0xd2803780)
  const offsetMovX0Literal = 0x120;
  buf.writeUInt32LE(0xd2803780 >>> 0, offsetMovX0Literal);

  // Offset 0x140: canonical mov x8, #439 (0xd28036e8)
  const offsetMovX8Canonical = 0x140;
  buf.writeUInt32LE(0xd28036e8 >>> 0, offsetMovX8Canonical);

  // Offset 0x200: ubfx x1, x2, #42, #3 (0xd36ab041)
  const offsetUbfx = 0x200;
  buf.writeUInt32LE(0xd36ab041 >>> 0, offsetUbfx);

  // Offset 0x220: lsl x11, x8, #42 (0xd356550b, immr=22, imms=21)
  const offsetLsl = 0x220;
  buf.writeUInt32LE(0xd356550b >>> 0, offsetLsl);

  // Offset 0x240: lsr x3, x4, #42 (0xd36abc83)
  const offsetLsr = 0x240;
  buf.writeUInt32LE((0xd36abc00 | (4 << 5) | 3) >>> 0, offsetLsr);

  // Offset 0x260: MmapAlignedLocked upper bound 1 << 48 (0xf2e00029)
  const offsetMmap = 0x260;
  buf.writeUInt32LE(0xf2e00029 >>> 0, offsetMmap);

  // Offset 0x280: RandomMmapHint split AND bitmasks (0x9240b908, 0x9253f109)
  const offsetAndPair = 0x280;
  buf.writeUInt32LE(0x9240b908 >>> 0, offsetAndPair);
  buf.writeUInt32LE(0x9253f109 >>> 0, offsetAndPair + 4);

  // Offset 0x2a0: inlined normal P0 tag movz x9, #0x1000, lsl #32 (0xd2c20009)
  const offsetMovzTag = 0x2a0;
  buf.writeUInt32LE(0xd2c20009 >>> 0, offsetMovzTag);

  // Offset 0x300: 0x1c0000000000n (TCMalloc tag mask)
  const offsetMask48 = 0x300;
  buf.writeBigUInt64LE(0x1c0000000000n, offsetMask48);

  // Offset 0x320: 0x040000000000n (1 << 42)
  const offsetFree48 = 0x320;
  buf.writeBigUInt64LE(0x040000000000n, offsetFree48);

  // Keep a clean copy to check zero collateral damage
  const original = Buffer.from(buf);

  // 2. Execute patch
  const res = patchArm64Binary(buf);

  assert.equal(res.patched, true, 'Patch should report success');
  assert.equal(res.matches.faccessat2, 3, 'Should match 3 faccessat2 syscalls');
  assert.equal(res.matches.tcmallocTagShift, 4, 'Should match 4 TCMalloc shift/bound instructions');
  assert.equal(res.matches.tcmallocTagMask, 5, 'Should match 5 TCMalloc mask/tag instructions & constants');

  // Verify instruction rewrites:
  assert.equal(buf.readUInt32LE(offsetMovX0Canonical), 0xd2800600 >>> 0, 'Canonical mov x0, #439 -> mov x0, #48');
  assert.equal(buf.readUInt32LE(offsetMovX0Literal), 0xd2800600 >>> 0, 'Literal mov x0, #439 -> mov x0, #48');
  assert.equal(buf.readUInt32LE(offsetMovX8Canonical), 0xd2800608 >>> 0, 'Canonical mov x8, #439 -> mov x8, #48');

  // TCMalloc constants rewritten to 39-bit layout
  assert.equal(buf.readBigUInt64LE(offsetMask48), 0x3800000000n, '0x1c0000000000 -> 0x3800000000');
  assert.equal(buf.readBigUInt64LE(offsetFree48), 0x0800000000n, '0x040000000000 -> 0x0800000000');
  assert.equal(buf.readUInt32LE(offsetMmap), 0xd3596129 >>> 0, 'MmapAligned 1<<48 -> 1<<39');
  assert.equal(buf.readUInt32LE(offsetAndPair), 0x92409508 >>> 0, '47-bit addr mask -> 38-bit addr mask');
  assert.equal(buf.readUInt32LE(offsetAndPair + 4), 0x925af109 >>> 0, '~(7<<42) -> ~(7<<35)');
  assert.equal(buf.readUInt32LE(offsetMovzTag), 0xd2c00409 >>> 0, '4<<42 -> 4<<35');

  // TCMalloc ubfx rewritten to shift 35
  const ubfxPatched = buf.readUInt32LE(offsetUbfx);
  assert.equal((ubfxPatched & 0xfffffc00) >>> 0, 0xd3639400 >>> 0, 'ubfx #42, #3 -> ubfx #35, #3');

  // TCMalloc lsl rewritten to shift 35
  const lslPatched = buf.readUInt32LE(offsetLsl);
  assert.equal((lslPatched & 0xfffffc00) >>> 0, 0xd35d7000 >>> 0, 'lsl #42 -> lsl #35');

  // Verify zero collateral damage on all other offsets
  const targetRanges = [
    [offsetMovX0Canonical, offsetMovX0Canonical + 4],
    [offsetMovX0Literal, offsetMovX0Literal + 4],
    [offsetMovX8Canonical, offsetMovX8Canonical + 4],
    [offsetUbfx, offsetUbfx + 4],
    [offsetLsl, offsetLsl + 4],
    [offsetLsr, offsetLsr + 4],
    [offsetMmap, offsetMmap + 4],
    [offsetAndPair, offsetAndPair + 8],
    [offsetMovzTag, offsetMovzTag + 4],
    [offsetMask48, offsetMask48 + 8],
    [offsetFree48, offsetFree48 + 8],
  ];

  for (let i = 0; i < buf.length; i++) {
    const isTarget = targetRanges.some(([start, end]) => i >= start && i < end);
    if (!isTarget) {
      assert.equal(buf[i], original[i], `Byte at offset 0x${i.toString(16)} must be untouched`);
    }
  }

  // 3. Test Idempotency
  const snapshotAfterPatch = Buffer.from(buf);
  const res2 = patchArm64Binary(buf);

  assert.equal(res2.patched, false, 'Second run must report patched: false');
  assert.equal(res2.totalPatches, 0, 'Second run must have 0 patches');
  assert.equal(res2.sha256Before, res.sha256After);
  assert.equal(res2.sha256After, res.sha256After);
  assert.deepEqual(buf, snapshotAfterPatch);
});

test('Real binary patching verification if real binaries exist', async () => {
  for (const name of ['localharness_external', 'agy_acp_server.par']) {
    const candidates = [resolve(name), resolve('..', name), resolve('dsh-go-acp', name)];
    const binPath = candidates.find(existsSync);
    if (binPath) {
      const patchRes = await patchExecutableFile(binPath);
      console.log(`[Real Binary Patch: ${binPath}]`);
      console.log(`  Patched: ${patchRes.patched}`);
      console.log(`  faccessat2 hits: ${patchRes.matches.faccessat2}`);
      console.log(`  tcmallocTagMask hits: ${patchRes.matches.tcmallocTagMask}`);
      console.log(`  tcmallocTagShift hits: ${patchRes.matches.tcmallocTagShift}`);
      console.log(`  Total patches: ${patchRes.totalPatches}`);
      console.log(`  SHA256 Before: ${patchRes.sha256Before}`);
      console.log(`  SHA256 After:  ${patchRes.sha256After}`);
      assert.equal(patchRes.sha256Before.length, 64);
      assert.equal(patchRes.sha256After.length, 64);

      // Verify idempotency on second run
      const secondRes = await patchExecutableFile(binPath);
      assert.equal(secondRes.patched, false, `Second patch on ${name} must be idempotent`);
      assert.equal(secondRes.totalPatches, 0);
      assert.equal(secondRes.sha256Before, patchRes.sha256After);
    }
  }
});
