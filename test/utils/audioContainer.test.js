const test = require("node:test");
const assert = require("node:assert/strict");

// The .ts import is stripped by tsx, which `npm test` loads via --import.

const load = () => import("../../src/utils/audioContainer.ts");

const readAscii = (view, offset, length) =>
  Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");

test("only the custom provider re-encodes, and only for containers a WAV/MP3/FLAC backend refuses", async () => {
  const { needsWavConversion } = await load();

  assert.equal(needsWavConversion("custom", "audio/webm;codecs=opus"), true);
  assert.equal(needsWavConversion("custom", "audio/ogg"), true);

  // Allowlisted rather than blocklisted: MediaRecorder emits MP4/AAC on some
  // platforms, and AAC is no more acceptable to these backends than Opus.
  assert.equal(needsWavConversion("custom", "audio/mp4"), true);
  assert.equal(needsWavConversion("custom", "video/webm"), true);

  // Already acceptable — re-encoding would only cost bytes.
  assert.equal(needsWavConversion("custom", "audio/wav"), false);
  assert.equal(needsWavConversion("custom", "audio/x-wav"), false);
  assert.equal(needsWavConversion("custom", "audio/mpeg"), false);
  assert.equal(needsWavConversion("custom", "audio/flac"), false);

  // Built-in providers accept Opus today; leaving them alone keeps uploads small.
  for (const provider of ["openai", "groq", "mistral", "xai", "gemini", "corti", "tinfoil"]) {
    assert.equal(needsWavConversion(provider, "audio/webm"), false);
  }

  // Missing type must not trigger a pointless decode.
  assert.equal(needsWavConversion("custom", undefined), false);
  assert.equal(needsWavConversion("custom", ""), false);

  // An empty recording has nothing to decode; attempting it would only log a
  // misleading "re-encode failed" warning.
  assert.equal(needsWavConversion("custom", "audio/webm", 0), false);
  assert.equal(needsWavConversion("custom", "audio/webm", 1024), true);
});

test("downmixToMono averages channels and passes mono through untouched", async () => {
  const { downmixToMono } = await load();

  const mono = new Float32Array([0.25, -0.5]);
  assert.equal(downmixToMono([mono]), mono, "mono input is returned as-is, not copied");

  const mixed = downmixToMono([new Float32Array([1, -1]), new Float32Array([0, 1])]);
  assert.deepEqual(Array.from(mixed), [0.5, 0]);

  assert.throws(() => downmixToMono([]), /at least one channel/);
});

test("encodeWav writes a RIFF header the upstream decoder can read", async () => {
  const { encodeWav } = await load();

  const frames = 8;
  const buffer = encodeWav([new Float32Array(frames)], 48000);
  const view = new DataView(buffer);

  assert.equal(readAscii(view, 0, 4), "RIFF");
  assert.equal(readAscii(view, 8, 4), "WAVE");
  assert.equal(readAscii(view, 12, 4), "fmt ");
  assert.equal(readAscii(view, 36, 4), "data");

  assert.equal(view.getUint16(20, true), 1, "PCM format tag");
  assert.equal(view.getUint16(22, true), 1, "channel count");
  assert.equal(view.getUint32(24, true), 48000, "sample rate");
  assert.equal(view.getUint32(28, true), 48000 * 2, "byte rate");
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");

  const dataBytes = frames * 2;
  assert.equal(view.getUint32(40, true), dataBytes, "data chunk size");
  assert.equal(view.getUint32(4, true), 36 + dataBytes, "riff size");
  assert.equal(buffer.byteLength, 44 + dataBytes);
});

test("samples outside [-1, 1] clamp to the rails instead of wrapping", async () => {
  const { encodeWav } = await load();

  // decodeAudioData can return values slightly past full scale; a naive
  // multiply-and-truncate turns +1.2 into a large negative sample.
  const view = new DataView(encodeWav([new Float32Array([1.2, -1.2, 1, -1, 0])], 16000));

  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
  assert.equal(view.getInt16(50, true), -32768);
  assert.equal(view.getInt16(52, true), 0);
});

test("multi-channel audio is interleaved per frame", async () => {
  const { encodeWav } = await load();

  const left = new Float32Array([1, 0]);
  const right = new Float32Array([0, -1]);
  const view = new DataView(encodeWav([left, right], 44100));

  assert.equal(view.getUint16(22, true), 2, "channel count");
  assert.equal(view.getUint32(28, true), 44100 * 2 * 2, "byte rate");
  assert.equal(view.getInt16(44, true), 32767, "frame 0 left");
  assert.equal(view.getInt16(46, true), 0, "frame 0 right");
  assert.equal(view.getInt16(48, true), 0, "frame 1 left");
  assert.equal(view.getInt16(50, true), -32768, "frame 1 right");
});

test("encodeWav refuses an empty channel list rather than emitting a headerless file", async () => {
  const { encodeWav } = await load();
  assert.throws(() => encodeWav([], 16000), /at least one channel/);
});

// 16 kHz mono test signals: a "speech" tone over faint noise, padded with
// noise-only stretches.
const RATE = 16000;
function signal(parts) {
  const total = parts.reduce((n, [seconds]) => n + Math.round(seconds * RATE), 0);
  const out = new Float32Array(total);
  let offset = 0;
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 2 - 1;
  };
  for (const [seconds, level] of parts) {
    const n = Math.round(seconds * RATE);
    for (let i = 0; i < n; i++) {
      const tone = level ? level * Math.sin((2 * Math.PI * 220 * (offset + i)) / RATE) : 0;
      out[offset + i] = tone + 0.003 * noise();
    }
    offset += n;
  }
  return out;
}

test("trimSilence drops the quiet start and end and keeps a margin around the speech", async () => {
  const { trimSilence } = await import("../../src/utils/audioContainer.ts");
  const input = signal([
    [1.5, 0],
    [3, 0.2],
    [2, 0],
  ]);

  const trimmed = trimSilence(input, RATE);

  const seconds = trimmed.length / RATE;
  // 3 s of speech plus ~0.25 s before and ~0.35 s after (one frame of slack).
  assert.ok(seconds > 3.5 && seconds < 3.7, `kept ${seconds}s`);
  const startSeconds = trimmed.byteOffset / 4 / RATE;
  assert.ok(Math.abs(startSeconds - 1.25) < 0.03, `starts at ${startSeconds}s`);
});

test("trimSilence keeps quiet speech between pauses intact", async () => {
  const { trimSilence } = await import("../../src/utils/audioContainer.ts");
  const input = signal([
    [1, 0],
    [1, 0.3],
    [1, 0],
    [1, 0.02],
    [1, 0],
  ]);

  const trimmed = trimSilence(input, RATE);

  // The quiet word at 3–4 s stays, so only the outer silence goes.
  assert.ok(trimmed.byteOffset / 4 / RATE < 0.8);
  assert.ok((trimmed.byteOffset / 4 + trimmed.length) / RATE > 4.3);
});

test("trimSilence leaves a recording unchanged when there is little to gain or no clear speech", async () => {
  const { trimSilence } = await import("../../src/utils/audioContainer.ts");
  const allSpeech = signal([[3, 0.2]]);
  const tinyMargins = signal([
    [0.3, 0],
    [3, 0.2],
    [0.3, 0],
  ]);
  const onlyNoise = signal([[3, 0]]);
  const digitalSilence = new Float32Array(RATE * 2);
  const tooShort = signal([[0.1, 0.2]]);

  for (const input of [allSpeech, tinyMargins, onlyNoise, digitalSilence, tooShort]) {
    assert.equal(trimSilence(input, RATE), input);
  }
});
