import test from "node:test";
import assert from "node:assert/strict";

import { buildStreamingSessionOptions } from "../../src/helpers/dictationStreamingRouting.js";
import {
  ULTRAFAST_PREVIEW_DEFAULT,
  buildUltrafastLanguageClause,
  collapseCjkSpaces,
  formatUltrafastLanguages,
  parseUltrafastLanguages,
  formatUltrafastPreview,
  getUltrafastPreviewOptions,
  parseUltrafastPreview,
  withUltrafastTranscription,
} from "../../src/helpers/ultrafastTranscription.js";

const standard = {
  geminiUltrafastEnabled: false,
  useLocalWhisper: true,
  transcriptionMode: "local",
  cloudTranscriptionMode: "openwhispr",
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionModel: "whisper-1",
  cloudTranscriptionBaseUrl: "https://example.test/v1",
  meetingCloudTranscriptionProvider: "",
};

test("Standard mode leaves the transcription settings untouched", () => {
  assert.equal(withUltrafastTranscription(standard), standard);
});

test("Ultrafast routes dictation to its own live preview model on the user's key", () => {
  const settings = withUltrafastTranscription({
    ...standard,
    geminiUltrafastEnabled: true,
    geminiUltrafastPreview: "deepgram/nova-3",
  });
  assert.equal(settings.useLocalWhisper, false);
  assert.equal(settings.transcriptionMode, "providers");
  assert.equal(settings.cloudTranscriptionMode, "byok");
  assert.equal(settings.cloudTranscriptionProvider, "deepgram");
  assert.equal(settings.cloudTranscriptionModel, "nova-3");
  assert.equal(settings.cloudTranscriptionBaseUrl, "");
  // Meeting and upload keys are not dictation's and stay as stored.
  assert.equal(settings.meetingCloudTranscriptionProvider, "");
});

test("an unset preview uses Gemini Live, and Off falls back to Gemini's batch model", () => {
  const unset = withUltrafastTranscription({ ...standard, geminiUltrafastEnabled: true });
  assert.equal(
    formatUltrafastPreview(unset.cloudTranscriptionProvider, unset.cloudTranscriptionModel),
    ULTRAFAST_PREVIEW_DEFAULT
  );

  const off = withUltrafastTranscription({
    ...standard,
    geminiUltrafastEnabled: true,
    geminiUltrafastPreview: "off",
  });
  assert.equal(off.cloudTranscriptionProvider, "gemini");
  assert.equal(off.cloudTranscriptionModel, "gemini-3.5-transcribe");
});

test("preview values parse back to provider and model", () => {
  assert.deepEqual(parseUltrafastPreview("tinfoil/voxtral-mini-4b-realtime"), {
    provider: "tinfoil",
    model: "voxtral-mini-4b-realtime",
  });
  for (const value of ["off", "", "gemini/", "/model", undefined]) {
    assert.equal(parseUltrafastPreview(value), null, String(value));
  }
});

test("preview options list only streaming models", () => {
  const options = getUltrafastPreviewOptions({
    transcriptionProviders: [
      {
        id: "gemini",
        name: "Gemini",
        models: [
          { id: "gemini-3.5-transcribe", name: "Batch" },
          { id: "gemini-3.5-transcribe-live", name: "Live", streaming: true },
        ],
      },
      { id: "groq", name: "Groq", models: [{ id: "whisper-large-v3", name: "Whisper" }] },
    ],
  });
  assert.deepEqual(
    options.map((o) => o.value),
    ["gemini/gemini-3.5-transcribe-live"]
  );
  assert.equal(options[0].providerName, "Gemini");
});

test("the bundled registry offers Gemini Live as a preview model", () => {
  assert.ok(getUltrafastPreviewOptions().some((o) => o.value === ULTRAFAST_PREVIEW_DEFAULT));
});

const LABELS = { "en-US": "English (US)", "zh-CN": "Chinese (Simplified)", ja: "Japanese" };
const label = (code) => LABELS[code];

test("language hints parse in order, without repeats or auto", () => {
  assert.deepEqual(parseUltrafastLanguages(" en-US, zh-CN,en-US,,auto"), ["en-US", "zh-CN"]);
  assert.deepEqual(parseUltrafastLanguages(undefined), []);
  assert.equal(formatUltrafastLanguages(["zh-CN", "zh-CN", "en-US"]), "zh-CN,en-US");
});

test("the language clause names one language, or allows switching between several", () => {
  assert.equal(buildUltrafastLanguageClause([], label), "");
  assert.equal(
    buildUltrafastLanguageClause(["ja"], label),
    " The primary spoken language is Japanese."
  );
  const mixed = buildUltrafastLanguageClause(["en-US", "zh-CN"], label);
  assert.match(mixed, /uses English \(US\) and Chinese \(Simplified\), and may switch/);
  assert.match(mixed, /never translate/);
  assert.match(mixed, /Chinese in Simplified characters/);
  assert.match(
    buildUltrafastLanguageClause(["en-US", "zh-CN", "ja"], label),
    /English \(US\), Chinese \(Simplified\), and Japanese/
  );
  // Both scripts chosen: no script is forced.
  assert.doesNotMatch(buildUltrafastLanguageClause(["zh-CN", "zh-TW"]), /characters/);
});

test("Ultrafast language hints set the language settings dictation runs on", () => {
  const base = { ...standard, geminiUltrafastEnabled: true, preferredLanguage: "ja" };
  const mixed = withUltrafastTranscription({ ...base, geminiUltrafastLanguages: "en-US,zh-CN" });
  assert.deepEqual(mixed.ultrafastLanguageHints, ["en-US", "zh-CN"]);
  assert.equal(mixed.preferredLanguage, "auto");
  assert.equal(mixed.chineseScriptPreference, "simplified");

  const single = withUltrafastTranscription({ ...base, geminiUltrafastLanguages: "zh-CN" });
  assert.equal(single.preferredLanguage, "zh-CN");

  const none = withUltrafastTranscription({ ...base, geminiUltrafastLanguages: "" });
  assert.equal(none.preferredLanguage, "ja");
  assert.equal(none.ultrafastLanguageHints, undefined);

  const standardMode = withUltrafastTranscription({
    ...base,
    geminiUltrafastEnabled: false,
    geminiUltrafastLanguages: "en-US,zh-CN",
  });
  assert.equal(standardMode.preferredLanguage, "ja");
});

test("Gemini Live sessions carry several hinted languages; other providers do not", () => {
  const settings = withUltrafastTranscription({
    ...standard,
    geminiUltrafastEnabled: true,
    geminiUltrafastLanguages: "en-US,zh-CN",
  });
  const gemini = buildStreamingSessionOptions({ providerName: "gemini", settings, language: "auto" });
  assert.deepEqual(gemini.languages, ["en-US", "zh-CN"]);
  assert.equal(gemini.language, undefined);
  const deepgram = buildStreamingSessionOptions({ providerName: "deepgram", settings });
  assert.equal(deepgram.languages, undefined);
});

test("spaces Gemini puts between Chinese or Japanese words are removed", () => {
  assert.equal(
    collapseCjkSpaces("在大人 的 陪同下 ， 一起 骑 自行车 ， 河边 扔 小 石头 滑滑梯 。"),
    "在大人的陪同下，一起骑自行车，河边扔小石头滑滑梯。"
  );
  assert.equal(collapseCjkSpaces("ねぇ 、 メール を 送って"), "ねぇ、メールを送って");
  // Spaces between CJK and Latin text or digits, English, and Korean stay.
  assert.equal(collapseCjkSpaces("这个任务大概需要 34 个小时。"), "这个任务大概需要 34 个小时。");
  assert.equal(collapseCjkSpaces("我们用 Gemini 做 dictation 吧"), "我们用 Gemini 做 dictation 吧");
  assert.equal(collapseCjkSpaces("Okay, I need 34 units."), "Okay, I need 34 units.");
  assert.equal(collapseCjkSpaces("안녕하세요 반갑습니다"), "안녕하세요 반갑습니다");
  // Line breaks between CJK sentences are kept.
  assert.equal(collapseCjkSpaces("第一段。\n第二段。"), "第一段。\n第二段。");
  assert.equal(collapseCjkSpaces(""), "");
});
