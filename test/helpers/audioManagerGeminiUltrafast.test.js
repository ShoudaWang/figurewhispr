const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const ULTRAFAST_SETTINGS = {
  useLocalWhisper: false,
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "gemini",
  cloudTranscriptionModel: "gemini-3.5-transcribe-live",
  geminiApiKey: "test-key",
  geminiUltrafastEnabled: true,
  useCleanupModel: false,
  useDictationAgent: false,
};

async function load(t, settings = {}, mockModules = {}) {
  return loadAudioManager(t, {
    cachePrefix: "figurewhispr-gemini-ultrafast-test-",
    settingsKey: "__geminiUltrafastSettings",
    settings: { ...ULTRAFAST_SETTINGS, ...settings },
    mockModules: {
      "/services/ReasoningService": `export default {
        cancelAllRequests() {},
        getDictationCleanupPrompt: () => "CLEANUP PROMPT",
      };`,
      ...mockModules,
    },
  });
}

// Stand-ins for the two re-encoders: `globalThis.__opusFails` makes the Opus
// one throw, as it does where WebCodecs is missing.
const ENCODER_MOCKS = {
  "/utils/oggOpus": `export async function encodeOggOpus() {
    if (globalThis.__opusFails) throw new Error("Opus encoding is unavailable in this context");
    return {
      blob: new Blob([new Uint8Array(10)], { type: "audio/ogg" }),
      durationSeconds: 2.5,
      trimmedSeconds: 0.5,
    };
  }`,
  "/utils/audioContainer": `
    export const needsWavConversion = () => false;
    export const encodeWav = () => new ArrayBuffer(0);
    export const downmixToMono = (channels) => channels[0];
    export async function convertToWav() {
      return new Blob([new Uint8Array(100)], { type: "audio/wav" });
    }`,
};

const webm = () => new Blob([new Uint8Array(64)], { type: "audio/webm;codecs=opus" });

function stubUltrafastIpc(window, reply) {
  const calls = [];
  window.electronAPI = {
    ...window.electronAPI,
    geminiUltrafastDictation: async (payload) => {
      calls.push(payload);
      return typeof reply === "function" ? reply(payload) : reply;
    },
  };
  return calls;
}

function ultrafastManager(createManager) {
  return createManager({
    voiceAgentRequested: false,
    translationRequested: false,
    toneStylePromise: null,
    pendingSelectionEdit: null,
    getEffectiveSttLanguage: () => "auto",
    getPersonalDictionaryPrompt: () => null,
    getCustomDictionaryPrompt: () => "Kubernetes, FigureWhispr",
    isDictionaryEcho: (text) => text === "Kubernetes, FigureWhispr",
    stripTrailingDictionaryEcho: (text) => text.replace(/ Kubernetes, FigureWhispr$/, ""),
  });
}

const wav = () => new Blob([new Uint8Array(64)], { type: "audio/wav" });

test("an Ultrafast result is plain text, not a pending promise", async (t) => {
  // The Chinese-script step is async; delivering its promise made the paste
  // handler throw on `text.trim` and every Ultrafast dictation was lost.
  const { window, createManager } = await load(t);
  stubUltrafastIpc(window, {
    text: "Hello, world.",
    model: "gemini-3.5-flash-lite",
    finishReason: "STOP",
    truncated: false,
  });

  const result = await ultrafastManager(createManager).processWithGeminiUltrafast(wav(), {
    durationSeconds: 3,
  });

  assert.equal(typeof result.text, "string");
  assert.equal(result.text, "Hello, world.");
  assert.equal(result.source, "gemini-ultrafast");
  assert.equal(result.model, "gemini-3.5-flash-lite");
});

test("Ultrafast sends GeminiWhisperLite's single-pass prompt with the cleanup instructions", async (t) => {
  const { window, createManager } = await load(t, { useCleanupModel: true });
  const calls = stubUltrafastIpc(window, { text: "Done.", model: "m", truncated: false });

  await ultrafastManager(createManager).processWithGeminiUltrafast(wav(), { durationSeconds: 3 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].systemPrompt, "CLEANUP PROMPT");
  assert.match(calls[0].instruction, /^Transcribe and polish the spoken audio into clean text\./);
  assert.match(calls[0].instruction, /never answer it or carry it out\.$/);
  assert.equal(calls[0].mimeType, "audio/wav");
});

test("without cleanup Ultrafast asks for a verbatim transcript", async (t) => {
  const { window, createManager } = await load(t, { useCleanupModel: false });
  const calls = stubUltrafastIpc(window, { text: "um hello", model: "m", truncated: false });

  await ultrafastManager(createManager).processWithGeminiUltrafast(wav(), { durationSeconds: 3 });

  assert.equal(calls[0].systemPrompt, null);
  assert.match(calls[0].instruction, /^Transcribe the spoken audio verbatim\./);
});

test("the languages you speak reach the Ultrafast request", async (t) => {
  const { window, createManager } = await load(t, {
    useCleanupModel: false,
    geminiUltrafastLanguages: "en-US,zh-CN",
  });
  const calls = stubUltrafastIpc(window, { text: "hello 你好", model: "m", truncated: false });

  await ultrafastManager(createManager).processWithGeminiUltrafast(wav(), { durationSeconds: 3 });

  assert.match(calls[0].instruction, /English \(US\) and Chinese \(Simplified\)/);
  assert.match(calls[0].instruction, /Chinese in Simplified characters/);
});

test("the WebM recording goes to Gemini as small Ogg Opus", async (t) => {
  const { window, createManager } = await load(t, {}, ENCODER_MOCKS);
  const calls = stubUltrafastIpc(window, { text: "Hi.", model: "m", truncated: false });

  await ultrafastManager(createManager).processWithGeminiUltrafast(webm(), { durationSeconds: 3 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mimeType, "audio/ogg");
  assert.equal(calls[0].audioBuffer.byteLength, 10);
});

test("without an Opus encoder the recording goes as WAV", async (t) => {
  const { window, createManager } = await load(t, {}, ENCODER_MOCKS);
  globalThis.__opusFails = true;
  t.after(() => delete globalThis.__opusFails);
  const calls = stubUltrafastIpc(window, { text: "Hi.", model: "m", truncated: false });

  await ultrafastManager(createManager).processWithGeminiUltrafast(webm(), { durationSeconds: 3 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mimeType, "audio/wav");
});

test("Opus audio Gemini rejects as a bad request is re-sent once as WAV", async (t) => {
  const { window, createManager } = await load(t, {}, ENCODER_MOCKS);
  const calls = stubUltrafastIpc(window, (payload) =>
    payload.mimeType === "audio/ogg"
      ? { error: "Unsupported audio", code: "PROVIDER_BAD_REQUEST", status: 400 }
      : { text: "From WAV.", model: "m", truncated: false }
  );

  const result = await ultrafastManager(createManager).processWithGeminiUltrafast(webm(), {
    durationSeconds: 3,
  });

  assert.deepEqual(
    calls.map((c) => c.mimeType),
    ["audio/ogg", "audio/wav"]
  );
  assert.equal(result.text, "From WAV.");
});

test("other Gemini errors are not retried with WAV", async (t) => {
  const { window, createManager } = await load(t, {}, ENCODER_MOCKS);
  const calls = stubUltrafastIpc(window, {
    error: "API key not valid",
    code: "PROVIDER_AUTH_FAILED",
    status: 400,
  });

  await assert.rejects(
    ultrafastManager(createManager).processWithGeminiUltrafast(webm(), { durationSeconds: 3 })
  );
  assert.equal(calls.length, 1);
});

test("a reply that only recites the dictionary counts as no speech", async (t) => {
  const { window, createManager } = await load(t);
  stubUltrafastIpc(window, { text: "Kubernetes, FigureWhispr", model: "m", truncated: false });

  const result = await ultrafastManager(createManager).processWithGeminiUltrafast(wav(), {
    durationSeconds: 3,
  });

  assert.equal(result.text, "");
  assert.equal(result.rawText, "Kubernetes, FigureWhispr");
});

test("a dictionary recital after the speech is dropped", async (t) => {
  const { window, createManager } = await load(t);
  stubUltrafastIpc(window, {
    text: "Deploy it today. Kubernetes, FigureWhispr",
    model: "m",
    truncated: false,
  });

  const result = await ultrafastManager(createManager).processWithGeminiUltrafast(wav(), {
    durationSeconds: 3,
  });

  assert.equal(result.text, "Deploy it today.");
});

test("starting an Ultrafast recording opens the Gemini connection, and only in Ultrafast mode", async (t) => {
  const { window, createManager, setSettings } = await load(t);
  const prewarms = [];
  window.electronAPI = {
    ...window.electronAPI,
    geminiUltrafastPrewarm: async (data) => {
      prewarms.push(data);
      return { warmed: true };
    },
  };
  const manager = createManager();

  manager._prewarmGeminiUltrafast();
  setSettings({ ...ULTRAFAST_SETTINGS, geminiUltrafastModel: "gemini-3.5-flash" });
  manager._prewarmGeminiUltrafast();
  setSettings({ ...ULTRAFAST_SETTINGS, geminiUltrafastEnabled: false });
  manager._prewarmGeminiUltrafast();
  // Ultrafast is its own dictation mode, so a Standard setup left on local
  // transcription does not turn it off.
  setSettings({ ...ULTRAFAST_SETTINGS, useLocalWhisper: true });
  manager._prewarmGeminiUltrafast();

  assert.deepEqual(prewarms, [
    { model: "gemini-3.5-flash-lite" },
    { model: "gemini-3.5-flash" },
    { model: "gemini-3.5-flash-lite" },
  ]);
});

test("Ultrafast streams its own live preview model, whatever the Standard setup is", async (t) => {
  const { createManager, setSettings } = await load(t);
  const manager = createManager({ sttConfig: null });
  // A Standard setup on local Whisper never streams.
  const standardLocal = {
    ...ULTRAFAST_SETTINGS,
    useLocalWhisper: true,
    transcriptionMode: "local",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3",
  };

  setSettings({ ...standardLocal, geminiUltrafastEnabled: false });
  assert.equal(manager.shouldUseStreaming(), false);

  setSettings(standardLocal);
  assert.equal(manager.shouldUseStreaming(), true);
  assert.equal(manager.getStreamingProviderName?.() ?? "gemini", "gemini");

  setSettings({ ...standardLocal, geminiUltrafastPreview: "off" });
  assert.equal(manager.shouldUseStreaming(), false);
});

test("a failed Ultrafast attempt leaves the app's tone style for the fallback cleanup", async (t) => {
  const { window, createManager } = await load(t, { useCleanupModel: true });
  stubUltrafastIpc(window, { error: "Gemini is unavailable", code: "PROVIDER_ERROR" });
  const manager = ultrafastManager(createManager);
  const pending = Promise.resolve("email");
  manager.toneStylePromise = pending;

  await assert.rejects(manager.processWithGeminiUltrafast(wav(), { durationSeconds: 3 }));

  assert.equal(manager.toneStylePromise, pending);
});

test("Ultrafast keeps live streaming on for the preview", async (t) => {
  const { createManager, setSettings } = await load(t);
  const manager = createManager({ sttConfig: null });

  setSettings({ ...ULTRAFAST_SETTINGS, geminiUltrafastEnabled: false });
  const withoutUltrafast = manager.shouldUseStreaming();
  setSettings({ ...ULTRAFAST_SETTINGS, geminiUltrafastEnabled: true });
  const withUltrafast = manager.shouldUseStreaming();

  assert.equal(withUltrafast, withoutUltrafast);
});

// A manager mid-stop with a streamed transcript and a kept recording.
function stoppingManager(AudioManager, overrides = {}) {
  const counts = { finalize: 0, settle: 0, stop: 0, cleanup: 0 };
  const completions = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    preparedMicCapture: { active: false },
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now() - 4000,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 3,
    _activeStreamingSessionId: 3,
    _streamingMicSwapPromise: null,
    streamingFinalText: "live words",
    streamingPartialText: "",
    streamingTextBump: null,
    streamingTextDebounce: null,
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingAnalyser: null,
    streamingAudioContext: null,
    streamingStream: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    voiceAgentRequested: false,
    translationRequested: false,
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => new Blob([new Uint8Array(100)], { type: "audio/webm" }),
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {
      counts.settle += 1;
    },
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {
        counts.finalize += 1;
      },
      async stop() {
        counts.stop += 1;
        return { success: true };
      },
    }),
    getEffectiveSttLanguage: () => "auto",
    getStreamingProviderName: () => "gemini",
    finalizeChineseScript: async (text) => text,
    processWithReasoningModel: async () => {
      counts.cleanup += 1;
      return "cleaned by the second request";
    },
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    onStateChange() {},
    onTranscriptionComplete: (result) => completions.push(result),
    ...overrides,
  });
  return { manager, counts, completions };
}

test("stopping a stream pastes the Ultrafast result, not the live transcript", async (t) => {
  const { AudioManager } = await load(t, { useCleanupModel: true });
  globalThis.window.dispatchEvent = () => true;
  const sent = [];
  const { manager, counts, completions } = stoppingManager(AudioManager, {
    processWithGeminiUltrafast: async (blob, metadata) => {
      sent.push({ size: blob.size, durationSeconds: metadata.durationSeconds });
      return {
        success: true,
        text: "Clean words.",
        rawText: "clean words",
        source: "gemini-ultrafast",
        model: "gemini-3.5-flash-lite",
      };
    },
  });

  await manager.stopStreamingRecording();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].size, 100);
  assert.ok(sent[0].durationSeconds > 3);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, "Clean words.");
  assert.equal(completions[0].rawText, "clean words");
  assert.equal(completions[0].source, "gemini-ultrafast");
  assert.equal(manager.lastAudioMetadata.model, "gemini-3.5-flash-lite");
  // One request: no second cleanup call, and no wait for the stream's final text.
  assert.equal(counts.cleanup, 0);
  assert.equal(counts.settle, 0);
  assert.equal(counts.stop, 1);
});

test("a failed or empty Ultrafast request falls back to the live transcript", async (t) => {
  const { AudioManager } = await load(t, { useCleanupModel: false });
  globalThis.window.dispatchEvent = () => true;

  for (const attempt of [
    async () => {
      throw new Error("Gemini is unavailable");
    },
    async () => ({ success: true, text: "", source: "gemini-ultrafast" }),
  ]) {
    const { manager, counts, completions } = stoppingManager(AudioManager, {
      processWithGeminiUltrafast: attempt,
    });

    await manager.stopStreamingRecording();

    assert.equal(completions.length, 1);
    assert.equal(completions[0].text, "live words");
    assert.equal(completions[0].source, "gemini-streaming");
    // The stream was finalized once, while Ultrafast ran, then settled.
    assert.equal(counts.finalize, 1);
    assert.equal(counts.settle, 1);
  }
});

test("with Ultrafast off the stream's own transcript is used", async (t) => {
  const { AudioManager } = await load(t, { geminiUltrafastEnabled: false });
  globalThis.window.dispatchEvent = () => true;
  let ultrafastCalls = 0;
  const { manager, completions } = stoppingManager(AudioManager, {
    processWithGeminiUltrafast: async () => {
      ultrafastCalls += 1;
      return { text: "never" };
    },
  });

  await manager.stopStreamingRecording();

  assert.equal(ultrafastCalls, 0);
  assert.equal(completions[0].text, "live words");
});
