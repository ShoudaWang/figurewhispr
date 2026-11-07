const test = require("node:test");
const assert = require("node:assert/strict");
const {
  runGeminiUltrafastDictation,
  outputTokenBudget,
} = require("../../src/helpers/geminiUltrafast");

const AUDIO = Buffer.from("fake-wav-bytes");

function makeFetch(response, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      headers: new Map(),
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  return { fetchImpl, calls };
}

const base = {
  audioBuffer: AUDIO,
  mimeType: "audio/wav",
  model: "gemini-3.5-flash-lite",
  systemPrompt: "Clean up the transcript.",
  instruction: "Transcribe and clean up the audio.",
  durationSeconds: 10,
  apiKey: "k1",
};

test("sends audio and cleanup prompt in one generateContent request", async () => {
  const { fetchImpl, calls } = makeFetch({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hello there." }] } }],
  });

  const result = await runGeminiUltrafastDictation(
    { ...base, thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } },
    fetchImpl
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
  );
  assert.equal(calls[0].init.headers["x-goog-api-key"], "k1");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Clean up the transcript." }] });
  const [audioPart, textPart] = body.contents[0].parts;
  assert.equal(audioPart.inlineData.mimeType, "audio/wav");
  assert.equal(audioPart.inlineData.data, AUDIO.toString("base64"));
  assert.equal(textPart.text, "Transcribe and clean up the audio.");
  assert.equal(body.generationConfig.temperature, 0);
  assert.deepEqual(body.generationConfig.thinkingConfig, {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
  assert.deepEqual(result, {
    text: "Hello there.",
    model: "gemini-3.5-flash-lite",
    finishReason: "STOP",
    truncated: false,
  });
});

test("omits the system instruction for verbatim transcription", async () => {
  const { fetchImpl, calls } = makeFetch({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "raw words" }] } }],
  });
  await runGeminiUltrafastDictation({ ...base, systemPrompt: null }, fetchImpl);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.systemInstruction, undefined);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});

test("skips thought parts and flags output cut off by the token cap", async () => {
  const { fetchImpl } = makeFetch({
    candidates: [
      {
        finishReason: "MAX_TOKENS",
        content: { parts: [{ text: "thinking…", thought: true }, { text: "partial" }] },
      },
    ],
  });
  const result = await runGeminiUltrafastDictation(base, fetchImpl);
  assert.equal(result.text, "partial");
  assert.equal(result.truncated, true);
});

test("rejects a missing API key without calling the API", async () => {
  const { fetchImpl, calls } = makeFetch({});
  await assert.rejects(runGeminiUltrafastDictation({ ...base, apiKey: "" }, fetchImpl));
  assert.equal(calls.length, 0);
});

test("surfaces HTTP failures as provider errors", async () => {
  const { fetchImpl } = makeFetch(
    { error: { message: "API key not valid", status: "INVALID_ARGUMENT" } },
    { ok: false, status: 400 }
  );
  await assert.rejects(runGeminiUltrafastDictation(base, fetchImpl));
});

test("output budget scales with the recording and stays bounded", () => {
  assert.equal(outputTokenBudget(1), 512);
  assert.equal(outputTokenBudget(100), 1200);
  assert.equal(outputTokenBudget(100000), 16384);
  assert.equal(outputTokenBudget(null), 1440);
});
