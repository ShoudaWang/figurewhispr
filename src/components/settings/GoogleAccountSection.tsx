import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Toggle } from "../ui/toggle";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Loader2, LogOut, RefreshCw, Download, Upload } from "../icons";
import { useToast } from "../ui/useToast";
import { openExternalLink } from "../../utils/externalLinks";
import type { GoogleAccountStatus } from "../../types/electron";
import {
  getLastSyncedAt,
  isApiKeySyncEnabled,
  isAutoSyncEnabled,
  restoreSettings,
  setApiKeySyncEnabled,
  setAutoSyncEnabled,
  syncNow,
  uploadSettings,
} from "../../services/googleSettingsSync";

const CLOUD_CONSOLE_URL = "https://console.cloud.google.com/apis/credentials";

type Busy = null | "signIn" | "signOut" | "sync" | "upload" | "restore" | "saveClient";

export default function GoogleAccountSection(): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const api = window.electronAPI?.googleAccount;
  const [status, setStatus] = useState<GoogleAccountStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [editingClient, setEditingClient] = useState(false);
  const [autoSync, setAutoSync] = useState(isAutoSyncEnabled());
  const [syncKeys, setSyncKeys] = useState(isApiKeySyncEnabled());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(getLastSyncedAt());

  const refresh = useCallback(async () => {
    if (!api) return;
    const [statusResult, clientResult] = await Promise.all([
      api.getStatus(),
      api.getClientConfig(),
    ]);
    if (statusResult.success) setStatus(statusResult.data);
    if (clientResult.success) setClientId(clientResult.data.clientId);
  }, [api]);

  useEffect(() => {
    void refresh();
    return api?.onStatusChanged((next) => {
      setStatus(next);
      setLastSyncedAt(getLastSyncedAt());
    });
  }, [api, refresh]);

  const fail = (error: unknown) =>
    toast({
      title: t("googleAccount.errorTitle"),
      description: error instanceof Error ? error.message : String(error),
      variant: "destructive",
    });

  const run = async (kind: Busy, action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
      setLastSyncedAt(getLastSyncedAt());
    }
  };

  const handleSaveClient = () =>
    run("saveClient", async () => {
      const result = await api!.saveClientConfig({ clientId, clientSecret });
      if (!result.success) throw new Error(result.error);
      setStatus(result.data);
      setClientSecret("");
      setEditingClient(false);
    });

  const handleSignIn = () =>
    run("signIn", async () => {
      const result = await api!.signIn();
      if (!result.success) {
        if (result.code === "CANCELLED") return;
        throw new Error(result.error);
      }
      setStatus(result.data);
      toast({
        title: t("googleAccount.signedInTitle"),
        description: t("googleAccount.signedInDescription", { email: result.data.email ?? "" }),
      });
      // First sign-in: take the account's settings if it has any, else upload ours.
      const outcome = await syncNow();
      if (outcome === "uploaded") {
        toast({ title: t("googleAccount.uploadedTitle") });
      }
    });

  const handleSignOut = () =>
    run("signOut", async () => {
      const result = await api!.signOut();
      if (!result.success) throw new Error(result.error);
      setStatus(result.data);
    });

  const handleSyncNow = () =>
    run("sync", async () => {
      const outcome = await syncNow();
      toast({
        title:
          outcome === "uploaded"
            ? t("googleAccount.uploadedTitle")
            : outcome === "applied"
              ? t("googleAccount.restoredTitle")
              : t("googleAccount.upToDateTitle"),
      });
    });

  const handleUpload = () =>
    run("upload", async () => {
      await uploadSettings();
      toast({ title: t("googleAccount.uploadedTitle") });
    });

  const handleRestore = () =>
    run("restore", async () => {
      const found = await restoreSettings();
      if (!found) toast({ title: t("googleAccount.nothingStoredTitle") });
    });

  if (!api) {
    return (
      <SectionHeader
        title={t("googleAccount.title")}
        description={t("googleAccount.unavailable")}
      />
    );
  }

  const clientForm = (
    <SettingsPanel>
      <SettingsPanelRow>
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">{t("googleAccount.client.title")}</p>
          <p className="text-xs leading-relaxed text-muted-foreground/80">
            {t("googleAccount.client.description")}{" "}
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => openExternalLink(CLOUD_CONSOLE_URL)}
            >
              {t("googleAccount.client.openConsole")}
            </button>
          </p>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234567890-abc.apps.googleusercontent.com"
            aria-label={t("googleAccount.client.clientId")}
            dir="ltr"
            className="h-8 text-xs"
          />
          <Input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={t("googleAccount.client.clientSecretPlaceholder")}
            aria-label={t("googleAccount.client.clientSecret")}
            dir="ltr"
            className="h-8 text-xs"
          />
          <div className="flex justify-end gap-2">
            {editingClient && (
              <Button size="sm" variant="ghost" onClick={() => setEditingClient(false)}>
                {t("common.cancel")}
              </Button>
            )}
            <Button size="sm" onClick={handleSaveClient} disabled={busy !== null}>
              {busy === "saveClient" && <Loader2 size={14} className="animate-spin" />}
              {t("googleAccount.client.save")}
            </Button>
          </div>
        </div>
      </SettingsPanelRow>
    </SettingsPanel>
  );

  return (
    <div className="space-y-5">
      <SectionHeader
        title={t("googleAccount.title")}
        description={t("googleAccount.description")}
      />

      {status && !status.configured ? (
        clientForm
      ) : status?.signedIn ? (
        <>
          <SettingsPanel>
            <SettingsPanelRow>
              <div className="flex items-center gap-3">
                {status.picture ? (
                  <img
                    src={status.picture}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-9 w-9 rounded-full"
                  />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-medium">
                    {(status.name || status.email || "?").slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {status.name || status.email}
                  </p>
                  {status.email && (
                    <p className="truncate text-xs text-muted-foreground">
                      <bdi dir="ltr">{status.email}</bdi>
                    </p>
                  )}
                </div>
                <Badge variant="outline">{t("googleAccount.connected")}</Badge>
                <Button size="sm" variant="ghost" onClick={handleSignOut} disabled={busy !== null}>
                  {busy === "signOut" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <LogOut size={14} />
                  )}
                  {t("googleAccount.signOut")}
                </Button>
              </div>
            </SettingsPanelRow>
          </SettingsPanel>

          <div>
            <SectionHeader
              title={t("googleAccount.sync.title")}
              description={
                lastSyncedAt
                  ? t("googleAccount.sync.lastSynced", {
                      time: new Date(lastSyncedAt).toLocaleString(),
                    })
                  : t("googleAccount.sync.neverSynced")
              }
            />
            <SettingsPanel>
              <SettingsPanelRow>
                <SettingsRow
                  label={t("googleAccount.sync.auto")}
                  description={t("googleAccount.sync.autoDescription")}
                >
                  <Toggle
                    checked={autoSync}
                    onChange={(value: boolean) => {
                      setAutoSync(value);
                      setAutoSyncEnabled(value);
                    }}
                    ariaLabel={t("googleAccount.sync.auto")}
                  />
                </SettingsRow>
              </SettingsPanelRow>
              <SettingsPanelRow>
                <SettingsRow
                  label={t("googleAccount.sync.apiKeys")}
                  description={t("googleAccount.sync.apiKeysDescription")}
                >
                  <Toggle
                    checked={syncKeys}
                    onChange={(value: boolean) => {
                      setSyncKeys(value);
                      setApiKeySyncEnabled(value);
                    }}
                    ariaLabel={t("googleAccount.sync.apiKeys")}
                  />
                </SettingsRow>
              </SettingsPanelRow>
              <SettingsPanelRow>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRestore}
                    disabled={busy !== null}
                  >
                    {busy === "restore" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {t("googleAccount.sync.restore")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleUpload}
                    disabled={busy !== null}
                  >
                    {busy === "upload" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Upload size={14} />
                    )}
                    {t("googleAccount.sync.upload")}
                  </Button>
                  <Button size="sm" onClick={handleSyncNow} disabled={busy !== null}>
                    {busy === "sync" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {t("googleAccount.sync.now")}
                  </Button>
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>
        </>
      ) : status ? (
        <>
          <SettingsPanel>
            <SettingsPanelRow>
              <SettingsRow
                label={t("googleAccount.signInLabel")}
                description={t("googleAccount.signInDescription")}
              >
                <div className="flex gap-2">
                  {busy === "signIn" && (
                    <Button size="sm" variant="ghost" onClick={() => void api.cancelSignIn()}>
                      {t("common.cancel")}
                    </Button>
                  )}
                  <Button size="sm" onClick={handleSignIn} disabled={busy !== null}>
                    {busy === "signIn" && <Loader2 size={14} className="animate-spin" />}
                    {t("googleAccount.signIn")}
                  </Button>
                </div>
              </SettingsRow>
            </SettingsPanelRow>
            {status.clientSource === "settings" && !editingClient && (
              <SettingsPanelRow>
                <SettingsRow label={t("googleAccount.client.title")} description={clientId}>
                  <Button size="sm" variant="ghost" onClick={() => setEditingClient(true)}>
                    {t("googleAccount.client.change")}
                  </Button>
                </SettingsRow>
              </SettingsPanelRow>
            )}
          </SettingsPanel>
          {editingClient && clientForm}
        </>
      ) : (
        <div className="flex justify-center py-6">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
