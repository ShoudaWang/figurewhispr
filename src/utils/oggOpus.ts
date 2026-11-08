// Small Ogg Opus files for Gemini Ultrafast. The recorder's WebM/Opus is
// re-encoded as low-bitrate mono Opus (about a tenth of the 16 kHz WAV) with
// WebCodecs, which only emits raw Opus packets, so this writes the Ogg
// container around them (RFC 3533 pages, RFC 7845 headers).

import { downmixToMono, trimSilence } from "./audioContainer";

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

const HEADER_TYPE = { continued: 1, first: 2, last: 4 };

function oggPage(
  segments: Uint8Array[],
  lacing: number[],
  {
    headerType,
    granule,
    serial,
    sequence,
  }: { headerType: number; granule: number; serial: number; sequence: number }
): Uint8Array {
  const bodyLength = segments.reduce((sum, s) => sum + s.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // version
  page[5] = headerType;
  view.setUint32(6, granule % 0x100000000, true);
  view.setUint32(10, Math.floor(granule / 0x100000000), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const s of segments) {
    page.set(s, offset);
    offset += s.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // mapping family 0: mono or stereo
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("FigureWhispr");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true); // no user comments
  return tags;
}

export interface OpusPacket {
  data: Uint8Array;
  /** Packet length in 48 kHz samples (Opus granule positions always count at 48 kHz). */
  samples: number;
}

/** Wraps raw Opus packets in an Ogg Opus file. */
export function buildOggOpus(
  packets: OpusPacket[],
  { channels = 1, preSkip = 312, inputSampleRate = 48000, serial = 0x46575350 } = {}
): Uint8Array<ArrayBuffer> {
  const pages: Uint8Array[] = [];
  let sequence = 0;
  const header = (data: Uint8Array, headerType: number) =>
    pages.push(
      oggPage([data], [data.length], { headerType, granule: 0, serial, sequence: sequence++ })
    );
  header(opusHead(channels, preSkip, inputSampleRate), HEADER_TYPE.first);
  header(opusTags(), 0);

  // Each packet is laced as 255-byte segments plus a shorter final one (a
  // zero-length one when it divides evenly); a page holds up to 255 segments.
  let segments: Uint8Array[] = [];
  let lacing: number[] = [];
  let granule = 0;
  const flush = (last: boolean) => {
    if (!lacing.length && !last) return;
    pages.push(
      oggPage(segments, lacing, {
        headerType: last ? HEADER_TYPE.last : 0,
        granule,
        serial,
        sequence: sequence++,
      })
    );
    segments = [];
    lacing = [];
  };
  for (const packet of packets) {
    const packetLacing = new Array(Math.floor(packet.data.length / 255)).fill(255);
    packetLacing.push(packet.data.length % 255);
    if (lacing.length + packetLacing.length > 255) flush(false);
    segments.push(packet.data);
    lacing.push(...packetLacing);
    granule += packet.samples;
  }
  flush(true);

  const out = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of pages) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Opus encodes speech at this rate as well as at 48 kHz for transcription, and
// lowest complexity keeps the encode about as fast as the WAV conversion.
const ENCODE_SAMPLE_RATE = 16000;
const ENCODE_BITRATE = 24000;

export interface EncodedOggOpus {
  blob: Blob;
  /** Length of the audio sent, after trimming. */
  durationSeconds: number;
  /** Silence trimmed from the start and end. */
  trimmedSeconds: number;
}

/**
 * Re-encodes a recording as small mono Ogg Opus, without the silence before
 * and after the speech. Throws when Web Audio or WebCodecs is unavailable or
 * the encoder fails, so callers can fall back.
 */
export async function encodeOggOpus(blob: Blob): Promise<EncodedOggOpus> {
  const g = globalThis as any;
  const OfflineCtor = g.OfflineAudioContext || g.webkitOfflineAudioContext;
  if (!OfflineCtor || typeof g.AudioEncoder !== "function" || typeof g.AudioData !== "function") {
    throw new Error("Opus encoding is unavailable in this context");
  }
  const config = {
    codec: "opus",
    sampleRate: ENCODE_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate: ENCODE_BITRATE,
    opus: { complexity: 0 },
  };
  const support = await g.AudioEncoder.isConfigSupported(config);
  if (!support?.supported) throw new Error("This Opus configuration is not supported");

  const context = new OfflineCtor(1, 1, ENCODE_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i));
  const full = downmixToMono(channels);
  const mono = trimSilence(full, decoded.sampleRate);

  const packets: OpusPacket[] = [];
  let preSkip = 312;
  let failure: unknown = null;
  const encoder = new g.AudioEncoder({
    output: (chunk: any, metadata: any) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, samples: Math.round(((chunk.duration ?? 20000) * 48000) / 1e6) });
      // The encoder's own OpusHead, when it gives one, carries its real pre-skip.
      const description = metadata?.decoderConfig?.description;
      if (description && description.byteLength >= 12) {
        const bytes = ArrayBuffer.isView(description)
          ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
          : new Uint8Array(description);
        preSkip = bytes[10] | (bytes[11] << 8);
      }
    },
    error: (error: unknown) => {
      failure = error;
    },
  });
  try {
    encoder.configure(config);
    encoder.encode(
      new g.AudioData({
        format: "f32",
        sampleRate: decoded.sampleRate,
        numberOfFrames: mono.length,
        numberOfChannels: 1,
        timestamp: 0,
        data: mono,
      })
    );
    await encoder.flush();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (failure) throw failure;
  if (!packets.length) throw new Error("The Opus encoder produced no audio");

  return {
    blob: new Blob([buildOggOpus(packets, { preSkip, inputSampleRate: decoded.sampleRate })], {
      type: "audio/ogg",
    }),
    durationSeconds: mono.length / decoded.sampleRate,
    trimmedSeconds: (full.length - mono.length) / decoded.sampleRate,
  };
}
