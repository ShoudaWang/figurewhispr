// OpenWhispr accounts (and everything behind them: OpenWhispr Cloud
// transcription/LLMs, workspaces, billing, leaderboards) are disabled in this
// build. The app runs entirely on local models or the user's own API keys, and
// settings sync through the user's Google account instead
// (src/services/googleSettingsSync.ts).
//
// Build with VITE_ENABLE_OPENWHISPR_ACCOUNTS=true to bring the legacy flow back.
// Kept free of browser/Electron imports so node tests can load it.
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
// Node (tests) has no import.meta.env; the renderer has no `process`.
const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env;

export const ACCOUNTS_ENABLED =
  (env?.VITE_ENABLE_OPENWHISPR_ACCOUNTS ?? nodeEnv?.VITE_ENABLE_OPENWHISPR_ACCOUNTS) === "true";

/** OpenWhispr Cloud needs an OpenWhispr account, so it follows the same switch. */
export const OPENWHISPR_CLOUD_ENABLED = ACCOUNTS_ENABLED;
