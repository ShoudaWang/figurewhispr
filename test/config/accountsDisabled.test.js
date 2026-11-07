const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// This build ships without OpenWhispr accounts (src/config/accounts.ts). Tests of
// the account/cloud mode set VITE_ENABLE_OPENWHISPR_ACCOUNTS themselves; these cover
// the default build, where it is unset.
delete process.env.VITE_ENABLE_OPENWHISPR_ACCOUNTS;

const UNMANAGED = { status: "unmanaged", policy: null };

test("accounts and OpenWhispr Cloud are off by default", async () => {
  const { ACCOUNTS_ENABLED, OPENWHISPR_CLOUD_ENABLED } =
    await import("../../src/config/accounts.ts");
  assert.equal(ACCOUNTS_ENABLED, false);
  assert.equal(OPENWHISPR_CLOUD_ENABLED, false);
});

test("OpenWhispr Cloud is never offered or allowed", async () => {
  const { isModeAllowedByPolicy, filterModeOptionsByPolicy } =
    await import("../../src/stores/policyRules.ts");
  assert.equal(isModeAllowedByPolicy(UNMANAGED, "transcription", "openwhispr"), false);
  assert.equal(isModeAllowedByPolicy(UNMANAGED, "transcription", "local"), true);
  assert.deepEqual(
    filterModeOptionsByPolicy(
      [{ id: "openwhispr" }, { id: "providers" }, { id: "local" }],
      "transcription",
      UNMANAGED
    ).map((option) => option.id),
    ["providers", "local"]
  );
});

async function loadStoreWith(t, initialStorage) {
  const { storage } = installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-accounts-disabled-test-" });
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  return { storage, store, state: store.useSettingsStore.getState() };
}

test("an existing install moves every Cloud scope to the user's own providers", async (t) => {
  const { state } = await loadStoreWith(t, {
    onboardingCompleted: "true",
    transcriptionMode: "openwhispr",
    cloudTranscriptionMode: "openwhispr",
    cleanupMode: "local",
    uploadCloudTranscriptionMode: "openwhispr",
  });

  assert.equal(state.transcriptionMode, "providers");
  assert.equal(state.cloudTranscriptionMode, "byok");
  assert.equal(state.cleanupMode, "local", "a scope off Cloud is left alone");
  // Unset scopes would have defaulted to Cloud.
  assert.equal(state.chatAgentMode, "providers");
  assert.equal(state.cleanupCloudMode, "byok");
  // Meeting and upload carry dictation's copy, which moves with it.
  assert.equal(state.meetingCloudTranscriptionMode, "byok");
  assert.equal(state.uploadCloudTranscriptionMode, "byok");
});

test("a first run leaves onboarding's own choices until onboarding finishes", async (t) => {
  const { storage, state, store } = await loadStoreWith(t, {});

  // Onboarding's BYOK steps reopen on a saved provider, so nothing may look saved yet.
  assert.notEqual(state.transcriptionMode, "providers");
  assert.notEqual(state.chatAgentMode, "providers");
  assert.equal(state.cleanupMode, "providers");
  assert.equal(state.cloudTranscriptionMode, "byok");

  storage.setItem("onboardingCompleted", "true");
  store.finishOpenWhisprCloudMigration();
  const after = store.useSettingsStore.getState();
  assert.equal(after.transcriptionMode, "providers");
  assert.equal(after.chatAgentMode, "providers");
  assert.equal(storage.getItem("chatAgentMode"), "providers");
});

test("onboarding's own choices are never overwritten", async (t) => {
  const { storage, store } = await loadStoreWith(t, {});
  storage.setItem("transcriptionMode", "local");
  storage.setItem("onboardingCompleted", "true");
  store.finishOpenWhisprCloudMigration();
  assert.equal(storage.getItem("transcriptionMode"), "local");
});
