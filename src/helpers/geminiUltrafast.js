// Gemini Ultrafast dictation: one multimodal generateContent request carries
// the recording and the cleanup instructions, so the user gets cleaned-up text
// after a single round trip instead of transcribe → send transcript → clean up.
// Ported from GeminiWhisperLite's transcribe_and_refine_single_pass.

const { net } = require("electron");
const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_ULTRAFAST_MODEL = "gemini-3.5-flash-lite";

// Formats Gemini documents for inline audio. The renderer converts anything
// else (Chromium's WebM/Opus) to WAV first.
const GEMINI_AUDIO_MIME_TYPES = {
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/mpeg": "audio/mp3",
  "audio/mp3": "audio/mp3",
  "audio/aac": "audio/aac",
  "audio/mp4": "audio/aac",
  "audio/ogg": "audio/ogg",
  "audio/flac": "audio/flac",
  "audio/aiff": "audio/aiff",
  "audio/webm": "audio/webm",
};

// Roughly 32 tokens per second of audio go in; speech is ~2.5 words/s, so cap
// the output generously above what the recording could hold. A runaway answer
// or repetition loop then stops instead of running to the model's limit.
function outputTokenBudget(durationSeconds) {
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 120;
  return Math.min(16384, Math.max(512, Math.ceil(seconds * 12)));
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => typeof part?.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
}

async function runGeminiUltrafastDictation(
  {
    audioBuffer,
    mimeType,
    model,
    systemPrompt,
    instruction,
    thinkingConfig,
    durationSeconds,
    apiKey,
    signal,
  },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "Gemini",
      surface: "transcription",
    });
  }
  const resolvedModel = (model || DEFAULT_ULTRAFAST_MODEL).replace(/^models\//, "");
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  const baseMime = String(mimeType || "audio/wav")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const geminiMime = GEMINI_AUDIO_MIME_TYPES[baseMime] || baseMime;

  const generationConfig = {
    temperature: 0,
    maxOutputTokens: outputTokenBudget(durationSeconds),
  };
  if (thinkingConfig && typeof thinkingConfig === "object") {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const body = {
    ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: geminiMime, data: buffer.toString("base64") } },
          { text: instruction },
        ],
      },
    ],
    generationConfig,
  };

  debugLogger.debug(
    "Gemini ultrafast dictation starting",
    { model: resolvedModel, mimeType: geminiMime, audioBytes: buffer.byteLength, durationSeconds },
    "transcription"
  );

  const started = Date.now();
  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const response = await doFetch(
    `${GEMINI_API_BASE}/${encodeURIComponent(resolvedModel)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    debugLogger.warn("Gemini ultrafast dictation failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    throw providerHttpError({
      provider: "Gemini",
      model: resolvedModel,
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason || null;
  const blockReason = data?.promptFeedback?.blockReason || null;
  const text = extractText(data);

  debugLogger.info(
    "Gemini ultrafast dictation finished",
    { model: resolvedModel, ms: Date.now() - started, finishReason, chars: text.length },
    "transcription"
  );

  if (blockReason) {
    throw new Error(`Gemini blocked the request (${blockReason})`);
  }
  return {
    text,
    model: resolvedModel,
    finishReason,
    // Cut off by the output cap: likely a repetition loop or an answer rather
    // than a transcript. The renderer falls back to the two-step pipeline.
    truncated: finishReason === "MAX_TOKENS",
  };
}

module.exports = { runGeminiUltrafastDictation, DEFAULT_ULTRAFAST_MODEL, outputTokenBudget };
