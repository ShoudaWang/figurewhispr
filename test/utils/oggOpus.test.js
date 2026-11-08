const test = require("node:test");
const assert = require("node:assert/strict");

// The .ts import is stripped by tsx, which `npm test` loads via --import.
const load = () => import("../../src/utils/oggOpus.ts");

// Bitwise Ogg CRC (polynomial 0x04c11db7, no reflection), independent of the
// table-driven one under test.
function referenceCrc(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

function parsePages(bytes) {
  const pages = [];
  let offset = 0;
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    assert.equal(String.fromCharCode(...bytes.subarray(offset, offset + 4)), "OggS");
    const segmentCount = bytes[offset + 26];
    const lacing = Array.from(bytes.subarray(offset + 27, offset + 27 + segmentCount));
    const bodyLength = lacing.reduce((a, b) => a + b, 0);
    const length = 27 + segmentCount + bodyLength;
    const page = bytes.slice(offset, offset + length);
    const storedCrc = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    pages.push({
      headerType: bytes[offset + 5],
      granule: view.getUint32(6, true) + view.getUint32(10, true) * 0x100000000,
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      crcOk: storedCrc === referenceCrc(page),
      lacing,
      body: bytes.subarray(offset + 27 + segmentCount, offset + length),
    });
    offset += length;
  }
  return pages;
}

// Reassembles packets from lacing values: a value under 255 ends a packet.
function packetsOf(pages) {
  const packets = [];
  let current = [];
  for (const page of pages.slice(2)) {
    let pos = 0;
    for (const value of page.lacing) {
      current.push(...page.body.subarray(pos, pos + value));
      pos += value;
      if (value < 255) {
        packets.push(Uint8Array.from(current));
        current = [];
      }
    }
  }
  return packets;
}

const packet = (size, fill, samples = 960) => ({
  data: new Uint8Array(size).fill(fill),
  samples,
});

test("the Ogg Opus file starts with OpusHead and OpusTags pages and checksums every page", async () => {
  const { buildOggOpus } = await load();
  const pages = parsePages(
    buildOggOpus([packet(40, 1), packet(60, 2)], { preSkip: 312, inputSampleRate: 16000 })
  );

  assert.equal(pages.length, 3);
  assert.ok(pages.every((p) => p.crcOk));
  assert.deepEqual(
    pages.map((p) => p.sequence),
    [0, 1, 2]
  );
  assert.equal(new Set(pages.map((p) => p.serial)).size, 1);
  assert.equal(pages[0].headerType, 2, "first page is marked beginning-of-stream");
  assert.equal(pages[2].headerType, 4, "last page is marked end-of-stream");

  const head = pages[0].body;
  assert.equal(String.fromCharCode(...head.subarray(0, 8)), "OpusHead");
  const headView = new DataView(head.buffer, head.byteOffset);
  assert.equal(head[8], 1, "version");
  assert.equal(head[9], 1, "mono");
  assert.equal(headView.getUint16(10, true), 312, "pre-skip");
  assert.equal(headView.getUint32(12, true), 16000, "input sample rate");
  assert.equal(String.fromCharCode(...pages[1].body.subarray(0, 8)), "OpusTags");
  assert.equal(pages[0].granule, 0);
  assert.equal(pages[2].granule, 1920, "granule counts 48 kHz samples of the packets");
});

test("packets of 255 bytes or more are laced across segments and come back intact", async () => {
  const { buildOggOpus } = await load();
  const input = [packet(255, 7), packet(600, 8), packet(3, 9)];
  const pages = parsePages(buildOggOpus(input));

  assert.deepEqual(pages[2].lacing, [255, 0, 255, 255, 90, 3]);
  assert.deepEqual(
    packetsOf(pages).map((p) => [p.length, p[0]]),
    [
      [255, 7],
      [600, 8],
      [3, 9],
    ]
  );
});

test("a long recording spreads over pages of at most 255 segments", async () => {
  const { buildOggOpus } = await load();
  const input = Array.from({ length: 700 }, (_, i) => packet(30, i % 250));
  const pages = parsePages(buildOggOpus(input));

  assert.ok(pages.length > 3);
  assert.ok(pages.every((p) => p.crcOk && p.lacing.length <= 255));
  assert.ok(pages.slice(2, -1).every((p) => p.headerType === 0));
  assert.equal(pages.at(-1).headerType, 4);
  const granules = pages.slice(2).map((p) => p.granule);
  assert.deepEqual(
    granules,
    [...granules].sort((a, b) => a - b)
  );
  assert.equal(granules.at(-1), 700 * 960);
  assert.equal(packetsOf(pages).length, 700);
});

test("without WebCodecs the encoder refuses so callers fall back to WAV", async () => {
  const { encodeOggOpus } = await load();
  await assert.rejects(encodeOggOpus(new Blob([new Uint8Array(8)])), /unavailable/);
});
