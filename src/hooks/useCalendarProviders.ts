import { useEffect, useState } from "react";
import type { CalendarProviderAvailability } from "../types/electron";

/**
 * Which calendars this build can connect, or null until main answers. Google
 * Calendar can reuse the Google sign-in client, so this rechecks whenever the
 * Google account changes (a client saved or removed in Settings → Account).
 */
export function useCalendarProviders(): CalendarProviderAvailability | null {
  const [providers, setProviders] = useState<CalendarProviderAvailability | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.calendarGetProviders) return;
    let disposed = false;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void api
        .calendarGetProviders?.()
        .then((next) => {
          if (!disposed && request === generation && next) setProviders(next);
        })
        .catch(() => {});
    };
    load();
    const unsubscribe = api.googleAccount?.onStatusChanged?.(load);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return providers;
}
