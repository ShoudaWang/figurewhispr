// Ultrafast dictation mode has its own live preview model, kept apart from the
// Standard mode's transcription setup so switching modes keeps both. The
// dictation pipeline reads transcription settings through
// withUltrafastTranscription(), which swaps in the preview model while
// Ultrafast is on: the live preview, and the transcript the pipeline falls back
// to when the Ultrafast request fails, both come from it. Its language hint (the
// languages the user speaks) reaches Gemini the same way. Pure module.
import { getRegistryData } from "../models/registryData.js";

export const ULTRAFAST_PREVIEW_OFF = "off";
export const ULTRAFAST_PREVIEW_DEFAULT = "gemini/gemini-3.5-transcribe-live";
// With the preview off, a failed Ultrafast request falls back to transcribing
// the finished recording with Gemini's batch model, on the same Gemini key.
export const ULTRAFAST_BATCH_FALLBACK = { provider: "gemini", model: "gemini-3.5-transcribe" };

export function formatUltrafastPreview(provider, model) {
  return provider && model ? `${provider}/${model}` : ULTRAFAST_PREVIEW_OFF;
}

/** Returns `{ provider, model }`, or null when the preview is off or unset. */
export function parseUltrafastPreview(value) {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** The streaming transcription models a live preview can use, from the registry. */
export function getUltrafastPreviewOptions(registry = getRegistryData()) {
  const options = [];
  for (const provider of registry?.transcriptionProviders ?? []) {
    for (const model of provider.models ?? []) {
      if (!model.streaming) continue;
      options.push({
        value: formatUltrafastPreview(provider.id, model.id),
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name,
      });
    }
  }
  return options;
}

/** The language codes in the Ultrafast language hint, in order, without repeats. */
export function parseUltrafastLanguages(value) {
  if (typeof value !== "string") return [];
  const codes = value
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code && code !== "auto");
  return [...new Set(codes)];
}

export function formatUltrafastLanguages(codes) {
  return parseUltrafastLanguages((codes ?? []).join(",")).join(",");
}

/**
 * The language sentence for the Ultrafast instruction. One language names it;
 * several also allow switching mid-sentence and forbid translating. A chosen
 * Chinese script is stated outright: without it Gemini writes mixed
 * English/Chinese speech in Traditional characters.
 */
export function buildUltrafastLanguageClause(codes, getLabel = (code) => code) {
  const list = parseUltrafastLanguages((codes ?? []).join(","));
  if (!list.length) return "";
  const labels = list.map((code) => getLabel(code) || code);
  let clause =
    list.length === 1
      ? ` The primary spoken language is ${labels[0]}.`
      : ` The speaker uses ${joinLabels(labels)}, and may switch between them mid-sentence.` +
        " Write each part in the language it was spoken; never translate.";
  const simplified = list.includes("zh-CN");
  const traditional = list.includes("zh-TW");
  if (simplified !== traditional) {
    clause += ` Write any Chinese in ${simplified ? "Simplified" : "Traditional"} characters with Chinese punctuation.`;
  }
  return clause;
}

function joinLabels(labels) {
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * The transcription settings dictation runs on. Unchanged unless Ultrafast is
 * on; then the dictation transcription selection becomes the Ultrafast preview
 * model on the user's own key (or Gemini's batch model with the preview off).
 * Meeting and upload transcription read their own keys and never see this.
 */
export function withUltrafastTranscription(settings) {
  if (!settings?.geminiUltrafastEnabled) return settings;
  const preview = parseUltrafastPreview(settings.geminiUltrafastPreview ?? ULTRAFAST_PREVIEW_DEFAULT);
  const { provider, model } = preview ?? ULTRAFAST_BATCH_FALLBACK;
  const languages = parseUltrafastLanguages(settings.geminiUltrafastLanguages);
  const languageSettings = {};
  if (languages.length) {
    languageSettings.ultrafastLanguageHints = languages;
    // One language pins transcription to it. Several leave detection on, since
    // pinning any one would mangle the others; the script choice still applies.
    languageSettings.preferredLanguage = languages.length === 1 ? languages[0] : "auto";
    const simplified = languages.includes("zh-CN");
    if (languages.length > 1 && simplified !== languages.includes("zh-TW")) {
      languageSettings.chineseScriptPreference = simplified ? "simplified" : "traditional";
    }
  }
  return {
    ...settings,
    ...languageSettings,
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: provider,
    cloudTranscriptionModel: model,
    // A custom endpoint belongs to the Standard setup, never to these providers.
    cloudTranscriptionBaseUrl: "",
  };
}
