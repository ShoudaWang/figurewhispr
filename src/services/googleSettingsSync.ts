// Settings sync through the user's Google account (replaces OpenWhispr cloud
// sync). The document lives in the app's hidden Google Drive appDataFolder;
// main (src/helpers/googleAccount.js) owns the OAuth tokens and Drive calls,
// this module decides what goes into the document and how it is applied.
//
// Settings persist in localStorage as raw strings, so the document carries
// those raw strings: applying it is a plain write-back, after which the app
// relaunches so every window rehydrates from the same values.

import { useSettingsStore } from "../stores/settingsStore";
import type { GoogleAccountStatus } from "../types/electron";
import logger from "../utils/logger";

const DOCUMENT_VERSION = 1;
const UPLOAD_DEBOUNCE_MS = 5_000;
const POLL_INTERVAL_MS = 15 * 60_000;

// Local bookkeeping, never synced.
const AUTO_SYNC_KEY = "googleSyncEnabled";
const INCLUDE_KEYS_KEY = "googleSyncIncludeApiKeys";
const LAST_HASH_KEY = "googleSyncLastHash";
const LAST_REMOTE_AT_KEY = "googleSyncLastRemoteAt";
const LAST_SYNCED_AT_KEY = "googleSyncLastSyncedAt";

// Settings stored outside the zustand store but still worth carrying over.
const EXTRA_KEYS = ["agentName", "uiLanguage"];

// Device-specific or account-bound values that must not travel between machines.
const EXCLUDED_KEYS = new Set([
  "isSignedIn",
  "noteFilesPath",
  "noteFilesEnabled",
  "onboardingCompleted",
  AUTO_SYNC_KEY,
  INCLUDE_KEYS_KEY,
  LAST_HASH_KEY,
  LAST_REMOTE_AT_KEY,
  LAST_SYNCED_AT_KEY,
]);
const SECRET_PATTERN = /(api.?key|secret|token|password|credential)/i;

// BYOK keys, synced only when the user opts in. Each pair is an electronAPI getter/saver.
const API_KEY_BRIDGES = [
  ["getOpenAIKey", "saveOpenAIKey"],
  ["getAnthropicKey", "saveAnthropicKey"],
  ["getGeminiKey", "saveGeminiKey"],
  ["getGroqKey", "saveGroqKey"],
  ["getXaiKey", "saveXaiKey"],
  ["getMistralKey", "saveMistralKey"],
  ["getOpenrouterKey", "saveOpenrouterKey"],
  ["getDeepgramKey", "saveDeepgramKey"],
  ["getAssemblyAIKey", "saveAssemblyAIKey"],
] as const;

export interface SettingsSyncDocument {
  version: number;
  updatedAt: number;
  deviceId: string;
  settings: Record<string, string>;
  apiKeys?: Record<string, string>;
}

type Bridge = NonNullable<NonNullable<Window["electronAPI"]>["googleAccount"]>;

function bridge(): Bridge | null {
  return window.electronAPI?.googleAccount ?? null;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the next pass recomputes.
  }
}

export const isAutoSyncEnabled = () => readFlag(AUTO_SYNC_KEY, true);
export const setAutoSyncEnabled = (value: boolean) => writeLocal(AUTO_SYNC_KEY, String(value));
export const isApiKeySyncEnabled = () => readFlag(INCLUDE_KEYS_KEY, false);
export const setApiKeySyncEnabled = (value: boolean) => writeLocal(INCLUDE_KEYS_KEY, String(value));
export function getLastSyncedAt(): number | null {
  const raw = Number(localStorage.getItem(LAST_SYNCED_AT_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function syncableKeys(): string[] {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const keys = Object.keys(state).filter((key) => typeof state[key] !== "function");
  return [...new Set([...keys, ...EXTRA_KEYS])].filter(
    (key) => !EXCLUDED_KEYS.has(key) && !SECRET_PATTERN.test(key)
  );
}

function snapshotSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of syncableKeys()) {
    const value = localStorage.getItem(key);
    if (value !== null) settings[key] = value;
  }
  return settings;
}

async function snapshotApiKeys(): Promise<Record<string, string>> {
  const api = window.electronAPI as unknown as Record<string, () => Promise<string | null>>;
  const keys: Record<string, string> = {};
  for (const [getter] of API_KEY_BRIDGES) {
    try {
      const value = await api?.[getter]?.();
      if (typeof value === "string" && value.trim()) keys[getter] = value;
    } catch {
      // A key that cannot be read is simply left out.
    }
  }
  return keys;
}

// Stable string for change detection (key order independent).
function stableHash(settings: Record<string, string>, apiKeys?: Record<string, string>): string {
  const ordered = (record: Record<string, string>) =>
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]);
  const text = JSON.stringify([ordered(settings), apiKeys ? ordered(apiKeys) : null]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${text.length}:${hash >>> 0}`;
}

async function buildLocalDocument(): Promise<SettingsSyncDocument> {
  const settings = snapshotSettings();
  const apiKeys = isApiKeySyncEnabled() ? await snapshotApiKeys() : undefined;
  const deviceResult = await bridge()?.getDeviceId();
  return {
    version: DOCUMENT_VERSION,
    updatedAt: Date.now(),
    deviceId: deviceResult?.success ? deviceResult.data : "unknown",
    settings,
    ...(apiKeys ? { apiKeys } : {}),
  };
}

function isDocument(value: unknown): value is SettingsSyncDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as SettingsSyncDocument;
  return (
    typeof doc.version === "number" &&
    typeof doc.updatedAt === "number" &&
    !!doc.settings &&
    typeof doc.settings === "object"
  );
}

export async function getStatus(): Promise<GoogleAccountStatus | null> {
  const result = await bridge()?.getStatus();
  return result?.success ? result.data : null;
}

/** Uploads this device's settings, replacing what is stored in the Google account. */
export async function uploadSettings(): Promise<void> {
  const api = bridge();
  if (!api) throw new Error("Google account bridge unavailable");
  const doc = await buildLocalDocument();
  const result = await api.writeSettings(doc);
  if (!result.success) throw new Error(result.error);
  writeLocal(LAST_HASH_KEY, stableHash(doc.settings, doc.apiKeys));
  writeLocal(LAST_REMOTE_AT_KEY, String(doc.updatedAt));
  writeLocal(LAST_SYNCED_AT_KEY, String(Date.now()));
  logger.info("Settings uploaded to Google", { keys: Object.keys(doc.settings).length }, "sync");
}

async function fetchRemote(): Promise<SettingsSyncDocument | null> {
  const api = bridge();
  if (!api) return null;
  const result = await api.readSettings();
  if (!result.success) throw new Error(result.error);
  return isDocument(result.data) ? result.data : null;
}

async function applyDocument(doc: SettingsSyncDocument): Promise<number> {
  const allowed = new Set(syncableKeys());
  let changed = 0;
  for (const [key, value] of Object.entries(doc.settings)) {
    if (!allowed.has(key) || typeof value !== "string") continue;
    if (localStorage.getItem(key) !== value) {
      writeLocal(key, value);
      changed++;
    }
  }
  // The dictionary also lives in SQLite; write it through the store so both agree.
  const dictionary = doc.settings.customDictionary;
  if (typeof dictionary === "string") {
    try {
      const words = JSON.parse(dictionary);
      if (Array.isArray(words)) {
        useSettingsStore.getState().setCustomDictionary(words.filter((w) => typeof w === "string"));
      }
    } catch {
      // Malformed entry: keep the local dictionary.
    }
  }
  if (doc.apiKeys && isApiKeySyncEnabled()) {
    const api = window.electronAPI as unknown as Record<string, (v: string) => Promise<unknown>>;
    for (const [getter, saver] of API_KEY_BRIDGES) {
      const value = doc.apiKeys[getter];
      if (typeof value === "string" && value.trim()) {
        try {
          await api?.[saver]?.(value);
          changed++;
        } catch {
          // Leave that key as it was.
        }
      }
    }
  }
  // Hash what this device now holds, the same way syncNow does, so the next
  // pass sees no local change.
  writeLocal(
    LAST_HASH_KEY,
    stableHash(snapshotSettings(), isApiKeySyncEnabled() ? await snapshotApiKeys() : undefined)
  );
  writeLocal(LAST_REMOTE_AT_KEY, String(doc.updatedAt));
  writeLocal(LAST_SYNCED_AT_KEY, String(Date.now()));
  return changed;
}

/**
 * Replaces local settings with the copy stored in the Google account and
 * relaunches so every window picks them up. Returns false when nothing is stored.
 */
export async function restoreSettings({ relaunch = true } = {}): Promise<boolean> {
  const doc = await fetchRemote();
  if (!doc) return false;
  const changed = await applyDocument(doc);
  logger.info("Settings restored from Google", { changed }, "sync");
  if (changed > 0 && relaunch) await window.electronAPI?.relaunchApp?.();
  return true;
}

/**
 * One reconciliation pass: a newer copy from another device is applied (and the
 * app relaunched); otherwise local changes since the last pass are uploaded.
 */
export async function syncNow(): Promise<"applied" | "uploaded" | "unchanged"> {
  const status = await getStatus();
  if (!status?.signedIn) return "unchanged";

  const remote = await fetchRemote();
  const lastRemoteAt = Number(localStorage.getItem(LAST_REMOTE_AT_KEY)) || 0;
  const localHash = stableHash(
    snapshotSettings(),
    isApiKeySyncEnabled() ? await snapshotApiKeys() : undefined
  );
  const localChanged = localHash !== localStorage.getItem(LAST_HASH_KEY);

  const deviceResult = await bridge()?.getDeviceId();
  const thisDevice = deviceResult?.success ? deviceResult.data : null;
  if (remote && remote.updatedAt > lastRemoteAt && remote.deviceId !== thisDevice) {
    // Another device saved since we last looked. Its copy wins unless this
    // device has unsynced edits *and* has synced before (first sign-in on a new
    // machine always takes the account's settings).
    if (!localChanged || lastRemoteAt === 0) {
      const changed = await applyDocument(remote);
      if (changed > 0) {
        logger.info("Applied newer settings from Google", { changed }, "sync");
        await window.electronAPI?.relaunchApp?.();
        return "applied";
      }
      return "unchanged";
    }
  }
  if (localChanged || !remote) {
    await uploadSettings();
    return "uploaded";
  }
  writeLocal(LAST_SYNCED_AT_KEY, String(Date.now()));
  return "unchanged";
}

/** Starts background sync; returns a stop function. Runs in one window only. */
export function startGoogleSettingsAutoSync(): () => void {
  const api = bridge();
  if (!api) return () => {};

  let disposed = false;
  let uploadTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const run = async (onlyIfChanged = false) => {
    if (disposed || running || !isAutoSyncEnabled()) return;
    running = true;
    try {
      if (onlyIfChanged) {
        const hash = stableHash(
          snapshotSettings(),
          isApiKeySyncEnabled() ? await snapshotApiKeys() : undefined
        );
        if (hash === localStorage.getItem(LAST_HASH_KEY)) return;
      }
      await syncNow();
    } catch (error) {
      logger.warn("Google settings sync failed", { error: (error as Error).message }, "sync");
    } finally {
      running = false;
    }
  };

  const scheduleUpload = () => {
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      uploadTimer = null;
      void run(true);
    }, UPLOAD_DEBOUNCE_MS);
  };

  // Settings written in this window update the store; writes from the control
  // panel arrive as storage events.
  const unsubscribeStore = useSettingsStore.subscribe(scheduleUpload);
  const onStorage = (event: StorageEvent) => {
    if (event.key && !EXCLUDED_KEYS.has(event.key) && !event.key.startsWith("googleSync")) {
      scheduleUpload();
    }
  };
  window.addEventListener("storage", onStorage);
  const unsubscribeStatus = api.onStatusChanged((status) => {
    if (status.signedIn) void run();
  });
  const poll = setInterval(() => void run(), POLL_INTERVAL_MS);
  const initial = setTimeout(() => void run(), 3_000);

  return () => {
    disposed = true;
    if (uploadTimer) clearTimeout(uploadTimer);
    clearTimeout(initial);
    clearInterval(poll);
    unsubscribeStore();
    window.removeEventListener("storage", onStorage);
    unsubscribeStatus();
  };
}
