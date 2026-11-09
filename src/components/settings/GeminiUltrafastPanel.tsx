import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import OptionCard from "../ui/OptionCard";
import ApiKeyInput from "../ui/ApiKeyInput";
import LanguageSelector, { type LanguageOption } from "../ui/LanguageSelector";
import languageRegistry from "../../config/languageRegistry.json";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { AudioLines, X, Zap } from "../icons";
import { selectResolvedLLMConfig, useSettingsStore } from "../../stores/settingsStore";
import { getRegistryData } from "../../models/registryData.js";
import {
  ULTRAFAST_BATCH_FALLBACK,
  ULTRAFAST_PREVIEW_DEFAULT,
  ULTRAFAST_PREVIEW_OFF,
  formatUltrafastLanguages,
  getUltrafastPreviewOptions,
  parseUltrafastLanguages,
  parseUltrafastPreview,
} from "../../helpers/ultrafastTranscription.js";

const LANGUAGE_OPTIONS: LanguageOption[] = languageRegistry.languages
  .filter((l) => l.code !== "auto")
  .map(({ code, label, flag }) => ({ value: code, label, flag }));

function languageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find((l) => l.value === code)?.label ?? code;
}

/**
 * The languages the user speaks, as removable chips plus an "add" picker.
 * Gemini gets them as a hint, which keeps mixed speech in the right language
 * and Chinese in the chosen script.
 */
function LanguageHintPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const selected = parseUltrafastLanguages(value);
  const remaining = LANGUAGE_OPTIONS.filter((l) => !selected.includes(l.value));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {selected.map((code) => (
        <span
          key={code}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 py-0.5 ps-2 pe-1 text-xs text-foreground"
        >
          {languageLabel(code)}
          <button
            type="button"
            onClick={() => onChange(formatUltrafastLanguages(selected.filter((c) => c !== code)))}
            aria-label={t("geminiUltrafast.removeLanguage", { language: languageLabel(code) })}
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <LanguageSelector
        value=""
        options={remaining}
        onChange={(code) => code && onChange(formatUltrafastLanguages([...selected, code]))}
        placeholder={t("geminiUltrafast.addLanguage")}
        className="min-w-36"
      />
    </div>
  );
}

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

type SettingsSnapshot = ReturnType<typeof useSettingsStore.getState>;

interface CredentialField {
  key: keyof SettingsSnapshot & string;
  setter: keyof SettingsSnapshot & string;
  labelKey?: string;
}

// What each live preview provider needs before it can stream. Gemini's key is
// the panel's own first row, so it never repeats here.
const PREVIEW_CREDENTIALS: Record<string, CredentialField[]> = {
  openai: [{ key: "openaiApiKey", setter: "setOpenaiApiKey" }],
  tinfoil: [{ key: "tinfoilApiKey", setter: "setTinfoilApiKey" }],
  deepgram: [{ key: "deepgramApiKey", setter: "setDeepgramApiKey" }],
  assemblyai: [{ key: "assemblyaiApiKey", setter: "setAssemblyaiApiKey" }],
  corti: [
    { key: "cortiClientId", setter: "setCortiClientId", labelKey: "transcription.corti.clientId" },
    {
      key: "cortiClientSecret",
      setter: "setCortiClientSecret",
      labelKey: "transcription.corti.clientSecret",
    },
  ],
};

function modelDisplayName(providerId: string, modelId: string): string {
  const registry = getRegistryData();
  const fromList = (list?: Array<{ id: string; models?: Array<{ id: string; name: string }> }>) =>
    list?.find((p) => p.id === providerId)?.models?.find((m) => m.id === modelId)?.name;
  return (
    fromList(registry.transcriptionProviders) || fromList(registry.cloudProviders) || modelId
  );
}

/**
 * Dictation mode: Ultrafast (Gemini hears and cleans up in one request) or
 * Standard (a transcription service, then a cleanup model). The choice decides
 * what the rest of the Speech to Text page shows.
 */
export function DictationModeChooser(): React.ReactElement {
  const { t } = useTranslation();
  const enabled = useSettingsStore((s) => s.geminiUltrafastEnabled);
  const setEnabled = useSettingsStore((s) => s.setGeminiUltrafastEnabled);

  return (
    <div>
      <SectionHeader
        title={t("geminiUltrafast.modeTitle")}
        description={t("geminiUltrafast.modeDescription")}
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <OptionCard
          icon={Zap}
          title={t("geminiUltrafast.ultrafastMode")}
          description={t("geminiUltrafast.ultrafastModeDescription")}
          selected={enabled}
          onSelect={() => setEnabled(true)}
        />
        <OptionCard
          icon={AudioLines}
          title={t("geminiUltrafast.standardMode")}
          description={t("geminiUltrafast.standardModeDescription")}
          selected={!enabled}
          onSelect={() => setEnabled(false)}
        />
      </div>
    </div>
  );
}

/**
 * Everything Ultrafast needs, in one place: the Gemini key, the model that
 * writes the final text, polished or verbatim output, the live preview model,
 * and what happens when the Ultrafast request fails.
 */
export default function GeminiUltrafastPanel({
  onOpenCleanupSettings,
}: {
  onOpenCleanupSettings?: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const {
    geminiUltrafastModel: model,
    geminiUltrafastPreview: rawPreview,
    geminiApiKey,
    geminiUltrafastLanguages,
    preferredLanguage,
    useCleanupModel,
    setGeminiUltrafastModel,
    setGeminiUltrafastPreview,
    setGeminiUltrafastLanguages,
    setGeminiApiKey,
    setShowTranscriptionPreview,
    updateCleanupSettings,
  } = store;

  // Multimodal Gemini chat models from the registry (Gemma and the dedicated
  // transcribe models don't take a system prompt with audio).
  const models = useMemo(() => {
    const gemini = getRegistryData().cloudProviders.find((p) => p.id === "gemini");
    const ids = (gemini?.models ?? [])
      .map((m) => ({ id: m.id, name: m.name }))
      .filter((m) => m.id.startsWith("gemini-"));
    if (model && !ids.some((m) => m.id === model)) ids.unshift({ id: model, name: model });
    return ids;
  }, [model]);

  const previewOptions = useMemo(() => getUltrafastPreviewOptions(), []);
  const previewValue = rawPreview || ULTRAFAST_PREVIEW_DEFAULT;
  const preview = parseUltrafastPreview(previewValue);
  const previewGroups = useMemo(() => {
    const groups = new Map<string, { name: string; options: typeof previewOptions }>();
    for (const option of previewOptions) {
      const group = groups.get(option.provider) ?? { name: option.providerName, options: [] };
      group.options.push(option);
      groups.set(option.provider, group);
    }
    return [...groups.entries()];
  }, [previewOptions]);
  const previewKnown = previewOptions.some((o) => o.value === previewValue);

  const missingGeminiKey = !geminiApiKey?.trim();
  const previewCredentials = preview ? (PREVIEW_CREDENTIALS[preview.provider] ?? []) : [];
  const credentialValue = (key: string) =>
    String((store as unknown as Record<string, unknown>)[key] ?? "");
  const credentialSetter = (setter: string) =>
    (store as unknown as Record<string, (value: string) => void>)[setter];
  const previewNeedsKey =
    (preview?.provider === "gemini" && missingGeminiKey) ||
    previewCredentials.some((field) => !credentialValue(field.key).trim());

  const handlePreviewChange = (value: string) => {
    setGeminiUltrafastPreview(value);
    // Choosing a preview model means the user wants to see it.
    if (value !== ULTRAFAST_PREVIEW_OFF) setShowTranscriptionPreview(true);
  };

  const cleanup = selectResolvedLLMConfig(store, "dictationCleanup");
  const cleanupName = cleanup.model
    ? modelDisplayName(cleanup.provider, cleanup.model)
    : t("geminiUltrafast.fallbackCleanupUnset");
  const transcriptSource = preview
    ? t("geminiUltrafast.fallbackLive", {
        model: modelDisplayName(preview.provider, preview.model),
      })
    : t("geminiUltrafast.fallbackBatch", {
        model: modelDisplayName(ULTRAFAST_BATCH_FALLBACK.provider, ULTRAFAST_BATCH_FALLBACK.model),
      });
  const fallbackDescription = useCleanupModel
    ? `${transcriptSource} ${t("geminiUltrafast.fallbackCleanup", { model: cleanupName })}`
    : transcriptSource;

  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("geminiUltrafast.apiKey")}
            description={t("geminiUltrafast.apiKeyDescription")}
          >
            {missingGeminiKey ? (
              <Badge variant="warning">{t("geminiUltrafast.missingKey")}</Badge>
            ) : (
              <Badge variant="success">{t("geminiUltrafast.connected")}</Badge>
            )}
          </SettingsRow>
          <ApiKeyInput
            className="mt-2"
            apiKey={geminiApiKey || ""}
            setApiKey={setGeminiApiKey}
            label=""
            ariaLabel={t("geminiUltrafast.apiKey")}
          />
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow
            label={t("geminiUltrafast.model")}
            description={t("geminiUltrafast.modelDescription")}
          >
            <Select value={model || DEFAULT_MODEL} onValueChange={setGeminiUltrafastModel}>
              <SelectTrigger className="h-8 w-56 text-xs" aria-label={t("geminiUltrafast.model")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow
            label={t("geminiUltrafast.output")}
            description={
              useCleanupModel
                ? t("geminiUltrafast.outputPolishedDescription")
                : t("geminiUltrafast.outputVerbatimDescription")
            }
          >
            <div
              role="radiogroup"
              aria-label={t("geminiUltrafast.output")}
              className="flex overflow-hidden rounded-md border border-border"
            >
              {[
                { value: true, label: t("geminiUltrafast.polished") },
                { value: false, label: t("geminiUltrafast.verbatim") },
              ].map((option) => {
                const selected = useCleanupModel === option.value;
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => updateCleanupSettings({ useCleanupModel: option.value })}
                    className={`px-3 py-1 text-xs transition-colors ${
                      selected
                        ? "bg-primary/10 font-medium text-primary dark:bg-primary/15"
                        : "text-muted-foreground hover:bg-foreground/5"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </SettingsRow>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow
            label={t("geminiUltrafast.languages")}
            description={
              parseUltrafastLanguages(geminiUltrafastLanguages).length
                ? t("geminiUltrafast.languagesDescription")
                : t("geminiUltrafast.languagesEmptyDescription", {
                    language:
                      preferredLanguage && preferredLanguage !== "auto"
                        ? languageLabel(preferredLanguage)
                        : t("geminiUltrafast.autoDetect"),
                  })
            }
          >
            {null}
          </SettingsRow>
          <LanguageHintPicker
            value={geminiUltrafastLanguages}
            onChange={setGeminiUltrafastLanguages}
          />
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow
            label={t("geminiUltrafast.previewModel")}
            description={
              preview
                ? t("geminiUltrafast.previewModelDescription")
                : t("geminiUltrafast.previewOffDescription")
            }
          >
            <div className="flex items-center gap-2">
              {previewNeedsKey && <Badge variant="warning">{t("geminiUltrafast.needsKey")}</Badge>}
              <Select value={previewValue} onValueChange={handlePreviewChange}>
                <SelectTrigger
                  className="h-8 w-56 text-xs"
                  aria-label={t("geminiUltrafast.previewModel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ULTRAFAST_PREVIEW_OFF} className="text-xs">
                    {t("geminiUltrafast.previewOff")}
                  </SelectItem>
                  {!previewKnown && preview && (
                    <SelectItem value={previewValue} className="text-xs">
                      {preview.model}
                    </SelectItem>
                  )}
                  {previewGroups.map(([providerId, group]) => (
                    <SelectGroup key={providerId}>
                      <SelectLabel className="text-xs">{group.name}</SelectLabel>
                      {group.options.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="text-xs">
                          {option.modelName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsRow>
          {previewCredentials.map((field) => (
            <ApiKeyInput
              key={field.key}
              className="mt-2"
              apiKey={credentialValue(field.key)}
              setApiKey={credentialSetter(field.setter)}
              label={field.labelKey ? t(field.labelKey) : ""}
              ariaLabel={field.labelKey ? t(field.labelKey) : t("apiKeyInput.label")}
            />
          ))}
        </SettingsPanelRow>
      </SettingsPanel>

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow label={t("geminiUltrafast.fallbackTitle")} description={fallbackDescription}>
            {useCleanupModel && onOpenCleanupSettings && (
              <Button type="button" variant="ghost" size="sm" onClick={onOpenCleanupSettings}>
                {t("geminiUltrafast.change")}
              </Button>
            )}
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}

/**
 * Shown on Language Model > Dictation Cleanup while Ultrafast is on: cleanup
 * happens inside the Ultrafast request, and the model below is only the backup.
 */
export function UltrafastCleanupNotice({
  onOpenUltrafastSettings,
}: {
  onOpenUltrafastSettings?: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-primary/25 bg-primary/5 p-3 dark:bg-primary/10">
      <div className="rounded-md bg-primary/10 p-1.5 text-primary dark:bg-primary/15">
        <Zap className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{t("geminiUltrafast.noticeTitle")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {t("geminiUltrafast.noticeDescription")}
        </p>
      </div>
      {onOpenUltrafastSettings && (
        <Button type="button" variant="outline" size="sm" onClick={onOpenUltrafastSettings}>
          {t("geminiUltrafast.openSettings")}
        </Button>
      )}
    </div>
  );
}
