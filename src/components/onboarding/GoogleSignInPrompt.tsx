import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Loader2 } from "../icons";
import type { GoogleAccountStatus } from "../../types/electron";

/**
 * Optional Google sign-in on the welcome screen. Only offered when an OAuth
 * client is configured (environment or Settings); otherwise it points to
 * Settings → Account, where the client can be added later.
 */
export default function GoogleSignInPrompt(): React.ReactElement | null {
  const { t } = useTranslation();
  const api = window.electronAPI?.googleAccount;
  const [status, setStatus] = useState<GoogleAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.getStatus().then((result) => result.success && setStatus(result.data));
    return api.onStatusChanged(setStatus);
  }, [api]);

  if (!api || !status) return null;

  if (status.signedIn) {
    return (
      <p className="mt-6 text-sm text-muted-foreground">
        {t("googleAccount.onboarding.signedInAs", { email: status.email ?? "" })}
      </p>
    );
  }

  if (!status.configured) {
    return (
      <p className="mt-6 text-xs text-muted-foreground">{t("googleAccount.onboarding.later")}</p>
    );
  }

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.signIn();
      if (!result.success) {
        if (result.code !== "CANCELLED") setError(result.error);
        return;
      }
      setStatus(result.data);
      // Pulls the account's settings when it has some (and relaunches to apply them).
      // Loaded on demand: the sync service pulls in the settings store.
      await import("../../services/googleSettingsSync")
        .then(({ syncNow }) => syncNow())
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      <Button variant="outline" onClick={signIn} disabled={busy} className="h-11 w-full">
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t("googleAccount.onboarding.signIn")}
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">
        {error ?? t("googleAccount.onboarding.hint")}
      </p>
    </div>
  );
}
