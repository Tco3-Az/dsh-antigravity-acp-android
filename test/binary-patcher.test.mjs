import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { patchArm64Binary, patchExecutableFile } from '../lib/binary-patcher.js';

test('ARM64 binary patcher synthetic ELF test', (t) => {
  // 1. Construct synthetic ELF Buffer
  const buf = Buffer.alloc(4096);

  // ELF Header magic
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]).copy(buf, 0);

  // Fill with dummy instructions (e.g. nop 0xd503201f, ret 0xd65f03c0)
  for (let i = 16; i < 4096; i += 4) {
    buf.writeUInt32LE(i % 8 === 0 ? 0xd503201f : 0xd65f03c0, i);
  }

  // Plant target patterns at known offsets:
  // Offset 0x100: mov x0, #439 (0xd2803780)
  const offsetMovX0 = 0x100;
  buf.writeUInt32LE(0xd2803780 >>> 0, offsetMovX0);

  // Offset 0x140: mov x8, #439 (0xd2803748)
  const offsetMovX8 = 0x140;
  buf.writeUInt32LE(0xd2803748 >>> 0, offsetMovX8);

  // Offset 0x200: ubfx x1, x2, #42, #3 (0xd36ab041)
  const offsetUbfx = 0x200;
  buf.writeUInt32LE(0xd36ab041 >>> 0, offsetUbfx);

  // Offset 0x240: lsr x3, x4, #42 (0xd36abfc3)
  const offsetLsr = 0x240;
  buf.writeUInt32LE((0xd36abc00 | (4 << 5) | 3) >>> 0, offsetLsr);

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
  assert.equal(res.matches.faccessat2, 2, 'Should match 2 faccessat2 syscalls');
  assert.equal(res.matches.tcmallocTagShift, 2, 'Should match 2 TCMalloc shift instructions');
  assert.equal(res.matches.tcmallocTagMask, 2, 'Should match 2 TCMalloc 64-bit constants');

  // Verify instruction rewrites:
  // mov x0, #48 (0xd2800600)
  assert.equal(buf.readUInt32LE(offsetMovX0), 0xd2800600 >>> 0, 'mov x0, #439 must be rewritten to mov x0, #48');
  assert.deepEqual(
    Array.from(buf.subarray(offsetMovX0, offsetMovX0 + 4)),
    [0x00, 0x06, 0x80, 0xd2],
    'Little-endian bytes must match [0x00, 0x06, 0x80, 0xd2]'
  );

  // mov x8, #48 (0xd2800608)
  assert.equal(buf.readUInt32LE(offsetMovX8), 0xd2800608 >>> 0, 'mov x8, #439 must be rewritten to mov x8, #48');
  assert.deepEqual(
    Array.from(buf.subarray(offsetMovX8, offsetMovX8 + 4)),
    [0x08, 0x06, 0x80, 0xd2],
    'Little-endian bytes must match [0x08, 0x06, 0x80, 0xd2]'
  );

  // TCMalloc constants rewritten to 39-bit layout
  assert.equal(buf.readBigUInt64LE(offsetMask48), 0x3800000000n, '0x1c0000000000 must be rewritten to 0x3800000000');
  assert.equal(buf.readBigUInt64LE(offsetFree48), 0x0800000000n, '0x040000000000 must be rewritten to 0x0800000000');

  // TCMalloc ubfx rewritten to shift 35
  const ubfxPatched = buf.readUInt32LE(offsetUbfx);
  assert.equal((ubfxPatched & 0xfffffc00) >>> 0, 0xd3639400 >>> 0, 'ubfx #42, #3 must be rewritten to ubfx #35, #3');

  // Verify zero collateral damage on all other offsets
  const targetRanges = [
    [offsetMovX0, offsetMovX0 + 4],
    [offsetMovX8, offsetMovX8 + 4],
    [offsetUbfx, offsetUbfx + 4],
    [offsetLsr, offsetLsr + 4],
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
  assert.equal(res2.sha256Before, res.sha256After, 'SHA256 before second run must equal SHA256 after first run');
  assert.equal(res2.sha256After, res.sha256After, 'SHA256 after second run must remain identical');
  assert.deepEqual(buf, snapshotAfterPatch, 'Buffer must be 100% byte-identical after second run');
});

test('Real binary patching verification if real binaries exist', async (t) => {
  const candidates = [
    resolve('localharness_external'),
    resolve('../localharness_external'),
    resolve('dsh-go-acp/localharness_external'),
  ];
  const localHarnessPath = candidates.find(existsSync);
  if (localHarnessPath) {
    const patchRes = await patchExecutableFile(localHarnessPath);
    console.log(`[Real Binary Patch: ${localHarnessPath}]`);
    console.log(`  Patched: ${patchRes.patched}`);
    console.log(`  faccessat2 hits: ${patchRes.matches.faccessat2}`);
    console.log(`  tcmallocTagMask hits: ${patchRes.matches.tcmallocTagMask}`);
    console.log(`  tcmallocTagShift hits: ${patchRes.matches.tcmallocTagShift}`);
    console.log(`  Total patches: ${patchRes.totalPatches}`);
    console.log(`  SHA256 Before: ${patchRes.sha256Before}`);
    console.log(`  SHA256 After:  ${patchRes.sha256After}`);
    assert.ok(patchRes.sha256Before.length === 64);
    assert.ok(patchRes.sha256After.length === 64);
  }
});
