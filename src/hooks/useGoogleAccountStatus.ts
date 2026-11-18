import { useEffect, useState } from "react";
import type { GoogleAccountStatus } from "../types/electron";

/** The Google account's sign-in state, kept current as the user signs in or out. */
export function useGoogleAccountStatus(): GoogleAccountStatus | null {
  const [status, setStatus] = useState<GoogleAccountStatus | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.googleAccount;
    if (!api) return;
    let disposed = false;
    // A change event that lands while the first read is in flight is newer: keep it.
    let changed = false;
    const unsubscribe = api.onStatusChanged((next) => {
      changed = true;
      if (!disposed) setStatus(next);
    });
    void api
      .getStatus()
      .then((result) => {
        if (!disposed && !changed && result.success) setStatus(result.data);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return status;
}
