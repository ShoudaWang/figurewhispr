import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useSettingsStore } from "../../stores/settingsStore";
import { getRegistryData } from "../../models/registryData.js";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

/**
 * Gemini Ultrafast: the recording and the cleanup prompt go to Gemini in one
 * multimodal request, so dictation costs a single round trip instead of
 * transcribe-then-clean-up. Mirrors GeminiWhisperLite's single-pass mode.
 */
export default function GeminiUltrafastPanel(): React.ReactElement {
  const { t } = useTranslation();
  const enabled = useSettingsStore((s) => s.geminiUltrafastEnabled);
  const model = useSettingsStore((s) => s.geminiUltrafastModel);
  const geminiKey = useSettingsStore((s) => s.geminiApiKey);
  const useLocal = useSettingsStore((s) => s.useLocalWhisper);
  const cleanupOn = useSettingsStore((s) => s.useCleanupModel);
  const setEnabled = useSettingsStore((s) => s.setGeminiUltrafastEnabled);
  const setModel = useSettingsStore((s) => s.setGeminiUltrafastModel);

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

  const missingKey = !geminiKey?.trim();

  return (
    <div>
      <SectionHeader
        title={t("geminiUltrafast.title")}
        description={t("geminiUltrafast.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("geminiUltrafast.enable")}
            description={
              cleanupOn ? t("geminiUltrafast.enableDescription") : t("geminiUltrafast.verbatimNote")
            }
          >
            <div className="flex items-center gap-2">
              {enabled && missingKey && (
                <Badge variant="warning">{t("geminiUltrafast.missingKey")}</Badge>
              )}
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                ariaLabel={t("geminiUltrafast.enable")}
              />
            </div>
          </SettingsRow>
        </SettingsPanelRow>
        {enabled && (
          <SettingsPanelRow>
            <SettingsRow
              label={t("geminiUltrafast.model")}
              description={
                useLocal ? t("geminiUltrafast.localNote") : t("geminiUltrafast.modelDescription")
              }
            >
              <Select value={model || DEFAULT_MODEL} onValueChange={setModel}>
                <SelectTrigger className="h-8 w-56 text-xs">
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
        )}
      </SettingsPanel>
    </div>
  );
}
