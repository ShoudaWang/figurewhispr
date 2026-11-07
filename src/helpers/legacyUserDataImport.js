// FigureWhispr keeps its own profile (%APPDATA%\FigureWhispr) so it can be
// installed beside a stock OpenWhispr, whose profile is %APPDATA%\open-whispr.
// The first launch copies that profile over, so settings, API keys, the
// dictionary, history and recordings carry across. Runs before the app is
// ready, synchronously, and never touches the source.
const fs = require("fs");
const path = require("path");

// Rebuilt by Chromium, owned by a running instance, or tied to the OpenWhispr
// account and workspace this build doesn't have.
const SKIPPED_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Shared Dictionary",
  "Crashpad",
  "logs",
  "sidecar-pids",
  "lockfile",
  "LOCK",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "DIPS",
  "DIPS-wal",
  ".updaterId",
  "auth-token.bin",
  "account-scope-binding.json",
  "workspace-policy.json",
]);

function copyTree(source, target, skipped) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) copyTree(from, to, skipped);
      else if (entry.isFile()) fs.copyFileSync(from, to);
    } catch {
      // A file a running OpenWhispr holds exclusively; the rest still comes over.
      skipped.push(from);
    }
  }
}

/**
 * Copies `legacyDir` to `targetDir` when `targetDir` doesn't exist yet.
 * Returns "imported", "fresh" (nothing to import) or "existing".
 */
function importLegacyUserData(legacyDir, targetDir, { log = console } = {}) {
  try {
    if (fs.existsSync(targetDir)) return "existing";
    if (!fs.existsSync(legacyDir) || !fs.statSync(legacyDir).isDirectory()) return "fresh";

    // Copy beside the target and rename at the end, so an interrupted copy is
    // retried on the next launch instead of leaving a half profile in place.
    const staging = `${targetDir}.importing`;
    fs.rmSync(staging, { recursive: true, force: true });
    const skipped = [];
    copyTree(legacyDir, staging, skipped);
    fs.renameSync(staging, targetDir);
    if (skipped.length > 0) {
      log.warn?.(`[Profile] Imported OpenWhispr profile without ${skipped.length} locked file(s)`);
    }
    log.info?.(`[Profile] Imported OpenWhispr profile from ${legacyDir}`);
    return "imported";
  } catch (error) {
    log.warn?.(`[Profile] Could not import the OpenWhispr profile: ${error?.message || error}`);
    return "fresh";
  }
}

module.exports = { importLegacyUserData, SKIPPED_NAMES };
