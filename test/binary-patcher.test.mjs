import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { patchArm64Binary, patchExecutableFile, patchTcmallocSlice } from '../lib/binary-patcher.js';

function words(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeUInt32LE(value >>> 0, i * 4));
  return buffer;
}
function assertIdempotent(buffer) {
  const snapshot = Buffer.from(buffer);
  assert.deepEqual(patchTcmallocSlice(buffer, true), { maskHits: 0, shiftHits: 0 });
  assert.deepEqual(buffer, snapshot);
}

const tagMoves = [
  [0xd2c20000, 0xd2c04000, 0xd2c00400, 0x20],
  [0xf2c20000, 0xf2c04000, 0xf2c00400, 0x20],
  [0xd2c10000, 0xd2c02000, 0xd2c00200, 0x10],
  [0xf2c38000, 0xf2c07000, 0xf2c00700, 0x38],
  [0xd2c30000, 0xd2c06000, 0xd2c00600, 0x30],
  [0xd2c08000, 0xd2c01000, 0xd2c00100, 0x8],
  [0xf2dff400, 0xf2dff400, 0xf2c00400, 0x20],
  [0xf2dff700, 0xf2dff700, 0xf2c00700, 0x38],
];

test('Pristine Tag42, experimental Tag39 and broken legacy MOVK migrate preserving every Rd', () => {
  for (const [original, previous, target, immediate] of tagMoves) {
    for (const source of [original, previous]) {
      for (let rd = 0; rd < 32; rd++) {
        const buffer = words([source | rd]);
        assert.deepEqual(patchTcmallocSlice(buffer, false), { maskHits: 1, shiftHits: 0 });
        assert.equal(buffer.readUInt32LE(), (target | rd) >>> 0);
        assert.equal((buffer.readUInt32LE() >>> 5) & 0xffff, immediate);
        assertIdempotent(buffer);
      }
    }
  }
});

test('Tag insertion/extraction migrates exact pairs but NEVER changes Span bound checks', () => {
  const pairs = [[42, 44, 35, 37], [39, 41, 35, 37], [22, 21, 29, 28], [25, 24, 29, 28]];
  for (const [immr, imms, targetR, targetS] of pairs) {
    for (const rn of [0, 8, 24, 31]) {
      for (const rd of [0, 9, 30, 31]) {
        const registers = (rn << 5) | rd;
        const buffer = words([0xd3400000 | (immr << 16) | (imms << 10) | registers]);
        assert.deepEqual(patchTcmallocSlice(buffer, false), { maskHits: 0, shiftHits: 1 });
        assert.equal(buffer.readUInt32LE(), (0xd3400000 | (targetR << 16) | (targetS << 10) | registers) >>> 0);
        assertIdempotent(buffer);
      }
    }
  }
  assertIdempotent(words([
    0xd3596129, // VA39 mmap upper bound
    0xd363fc0a, 0xd363ff08, // Span/PageId >>35 checks (previous candidate broke these)
    0xd358ff0a, 0xb3408808, // PageMap index and Span PageId bitfield
    0xd36abc83, 0xd36afc83, // NOT the three-bit tag extraction
    0x532a3001, 0xd36aa401, // unrelated/mismatched UBFM
    0xb76008ca, 0xb6600408, // /proc/kpageflags bit44, NOT allocator tag bits
    0xb7285000, 0xb7286800, // unrelated bit37 tests
  ]));
});

test('ROOT CAUSE: Span PageId tag extraction reads bits22..24 and nothing above them', () => {
  for (const pattern of [0x531d7c00, 0x531a7000, 0x531a7c00]) {
    for (const rn of [0, 9, 22, 31]) {
      const buffer = words([pattern | (rn << 5) | 9]);
      assert.equal(patchTcmallocSlice(buffer, false).shiftHits, 1);
      const instruction = buffer.readUInt32LE();
      assert.equal(instruction, (0x53166000 | (rn << 5) | 9) >>> 0);
      const shift = (instruction >>> 16) & 31;
      const width = ((instruction >>> 10) & 31) - shift + 1;
      assert.equal(shift, 22);
      assert.equal(width, 3, 'LSR #22 alone would accidentally include real address bits');
      for (let tag = 0n; tag < 8n; tag++) {
        const address = (tag << 35n) | 0x7ffffe000n;
        const pageId = address >> 13n;
        assert.equal((pageId >> BigInt(shift)) & ((1n << BigInt(width)) - 1n), tag);
      }
      assertIdempotent(buffer);
    }
  }
});

test('PageId masks and adjacent Tag2 comparands migrate together', () => {
  for (const [mask, compare] of [[0x92630800, 0x52a80000], [0x92660800, 0x52a10000]]) {
    const buffer = words([mask | (17 << 5) | 8, 0xd503201f, compare | 9, 0xeb09011f]);
    assert.equal(patchTcmallocSlice(buffer, false).maskHits, 2);
    assert.equal(buffer.readUInt32LE(), (0x926a0800 | (17 << 5) | 8) >>> 0);
    assert.equal(buffer.readUInt32LE(8), 0x52a01009);
    assertIdempotent(buffer);
  }
});

test('Masks, sampled/cold tests, guarded bit branches and legacy hints migrate consistently', () => {
  for (const mask of [0x92560800, 0x92590800]) {
    const buffer = words([mask | (17 << 5) | 3]);
    assert.equal(patchTcmallocSlice(buffer, false).maskHits, 1);
    assert.equal(buffer.readUInt32LE(), (0x925d0800 | (17 << 5) | 3) >>> 0);
    assertIdempotent(buffer);
  }
  for (const mask of [0xf2550400, 0xf2580400]) {
    const buffer = words([mask | (2 << 5) | 31]);
    assert.equal(patchTcmallocSlice(buffer, false).maskHits, 1);
    assert.equal(buffer.readUInt32LE(), 0xf25c045f);
    assertIdempotent(buffer);
  }
  for (const bit of [43, 40]) {
    for (const branch of [0xb6000000, 0xb7000000]) {
      const buffer = words([branch | ((bit - 32) << 19) | 0x4a0]);
      assert.equal(patchTcmallocSlice(buffer, false).shiftHits, 1);
      assert.equal(buffer.readUInt32LE(), (branch | (4 << 19) | 0x4a0) >>> 0);
      assertIdempotent(buffer);
    }
  }
  for (const [addr, tag] of [[0x9240b908, 0x9253f109], [0x92409508, 0x9256f109], [0x92409508, 0x925af109], [0x92408908, 0x925af109]]) {
    const buffer = words([addr, tag]);
    patchTcmallocSlice(buffer, false);
    assert.deepEqual(buffer, words([0x92408908, 0x925af109]));
    assertIdempotent(buffer);
  }
});

test('Raw literals are opt-in and migrate Tag42/39 to Tag35', () => {
  for (const [source, target] of [[7n << 42n, 7n << 35n], [7n << 39n, 7n << 35n], [1n << 42n, 1n << 35n], [1n << 39n, 1n << 35n]]) {
    const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(source);
    assert.deepEqual(patchTcmallocSlice(Buffer.from(buffer), false), { maskHits: 0, shiftHits: 0 });
    patchTcmallocSlice(buffer, true);
    assert.equal(buffer.readBigUInt64LE(), target);
    assertIdempotent(buffer);
  }
});

test('Syscall patching requires SVC or a verified wrapper, not arbitrary constants or SVE indices', () => {
  const buffer = words([
    0xd28036e8, 0xd4000001, // direct svc
    0x528036e8, 0xd4000001,
    0xaa1f03e5, 0xaa1f03e6, 0xd28036e0, 0x94000003,
    0xd28036e8, 0xe548409f, // real libjxl SVE index 439 (must stay)
    0x528036e0, 0x94000003, // allocation size/source line 439 (must stay)
    0xd2803748, 0xd2803780, // old fake patterns encode 442/444, NOT 439
  ]);
  const before = Buffer.from(buffer);
  const result = patchArm64Binary(buffer);
  assert.equal(result.matches.faccessat2, 3);
  assert.equal(buffer.readUInt32LE(0), 0xd2800608);
  assert.equal(buffer.readUInt32LE(8), 0x52800608);
  assert.equal(buffer.readUInt32LE(24), 0xd2800600);
  assert.deepEqual(buffer.subarray(32), before.subarray(32));
  assert.equal(patchArm64Binary(buffer).totalPatches, 0);
});

test('Embedded helper RandomMmapHint mask is reduced to 35 bits', () => {
  for (const rd of [0, 8, 9, 19, 30]) {
    for (const prior38 of [false, true]) {
      const buffer = words([
        (prior38 ? 0x92800000 : 0x92d38000) | rd,
        0xd280016a, 0xcb0803e8,
        prior38 ? (0xd35afc00 | (rd << 5) | rd) : (0xf2e00000 | rd),
      ]);
      assert.equal(patchTcmallocSlice(buffer, false).maskHits, prior38 ? 1 : 2);
      assert.equal(buffer.readUInt32LE(), (0x92800000 | rd) >>> 0);
      assert.equal(buffer.readUInt32LE(12), (0xd35dfc00 | (rd << 5) | rd) >>> 0);
      assertIdempotent(buffer);
    }
  }
});

function sectionedElf() {
  const buffer = Buffer.alloc(4096);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(buffer);
  buffer.writeUInt16LE(2, 16);
  buffer.writeUInt16LE(183, 18);
  buffer.writeBigUInt64LE(0x100n, 40);
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(4, 60);
  buffer.writeUInt16LE(1, 62);
  const names = Buffer.from('\0.shstrtab\0google_malloc\0.text\0');
  names.copy(buffer, 0x300);
  for (const [index, nameOffset, fileOffset, size, flags] of [
    [1, 1, 0x300, names.length, 0],
    [2, 11, 0x400, 16, 6],
    [3, 25, 0x500, 16, 6],
  ]) {
    const base = 0x100 + index * 64;
    buffer.writeUInt32LE(nameOffset, base);
    buffer.writeBigUInt64LE(BigInt(flags), base + 8);
    buffer.writeBigUInt64LE(BigInt(fileOffset), base + 24);
    buffer.writeBigUInt64LE(BigInt(size), base + 32);
  }
  words([0xd36ab041, 0xd2c20009, 0xd28036e8, 0xd4000001]).copy(buffer, 0x400);
  words([0xd36ab041, 0xd2c20009, 0xd28036e8, 0xd4000001]).copy(buffer, 0x500);
  return buffer;
}

test('Valid ELF patches TCMalloc only inside google_malloc', () => {
  const buffer = sectionedElf();
  const original = Buffer.from(buffer);
  const result = patchArm64Binary(buffer);
  assert.equal(result.matches.tcmallocTotal, 2);
  assert.equal(result.matches.faccessat2, 2);
  assert.equal(buffer.readUInt32LE(0x400), 0xd3639441);
  assert.equal(buffer.readUInt32LE(0x404), 0xd2c00409);
  assert.deepEqual(buffer.subarray(0x500, 0x508), original.subarray(0x500, 0x508));
  assert.equal(patchArm64Binary(buffer).totalPatches, 0);
});

test('Large executable streaming patch is scoped and idempotent', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'agy-va39-'));
  const path = resolve(dir, 'synthetic.elf');
  try {
    const file = await open(path, 'w');
    try {
      await file.write(sectionedElf(), 0, 4096, 0);
      await file.truncate(201 * 1024 * 1024);
    } finally {
      await file.close();
    }
    const result = await patchExecutableFile(path);
    assert.equal(result.matches.tcmallocTotal, 2);
    assert.equal(result.matches.faccessat2, 2);
    const fileRead = await open(path, 'r');
    const head = Buffer.alloc(4096);
    try { await fileRead.read(head, 0, head.length, 0); } finally { await fileRead.close(); }
    assert.equal(head.readUInt32LE(0x400), 0xd3639441);
    assert.equal(head.readUInt32LE(0x500), 0xd36ab041);
    assert.equal(head.readUInt32LE(0x508), 0xd2800608);
    const second = await patchExecutableFile(path);
    assert.equal(second.totalPatches, 0);
    assert.equal(second.sha256Before, result.sha256After);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tag35 random hints obey VA39 bounds and PageId tags survive round trips', () => {
  const baseMask = (1n << 35n) - 1n;
  const tagMask = 7n << 35n;
  assert.equal(baseMask & tagMask, 0n);
  for (let tag = 0n; tag < 8n; tag++) {
    const address = baseMask | (tag << 35n);
    assert.ok(address < (1n << 38n));
    assert.ok(address < (1n << 39n));
    assert.equal(((address >> 13n) >> 22n) & 7n, tag);
    assert.ok((address >> 13n) < (1n << 35n));
  }
});

test('Tag39 non-overlap does NOT imply 39-bit mmap compatibility', () => {
  const baseMask = (1n << 38n) - 1n;
  const tagMask = 7n << 39n;
  const kernelBound = 1n << 39n;
  assert.equal(baseMask & tagMask, 0n);
  for (let tag = 1n; tag <= 7n; tag++) {
    const hint = baseMask | (tag << 39n);
    assert.ok(hint >= kernelBound, `nonzero Tag${tag} is outside the 39-bit VA range`);
    assert.ok((hint >> 13n) < (1n << 35n), 'Span bound alone cannot validate mmap');
  }
  assert.equal(4n << 39n, 2n << 40n, 'normal Tag4 requires at least a 2TiB mapping');
  assert.equal((0x7feefd6000n & tagMask) >> 39n, 0n, '39-bit fallback addresses lose all Tag39 information');
});

test('Explicit real-binary integration patches a temporary copy only', {
  skip: !process.env.AGY_TEST_BINARY,
}, async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'agy-real-va39-'));
  const path = resolve(dir, 'agy_acp_server.par');
  try {
    await copyFile(resolve(process.env.AGY_TEST_BINARY), path);
    const result = await patchExecutableFile(path);
    assert.equal(result.sha256Before.length, 64);
    const second = await patchExecutableFile(path);
    assert.equal(second.totalPatches, 0);
    assert.equal(second.sha256Before, result.sha256After);
    console.log(JSON.stringify(result));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
