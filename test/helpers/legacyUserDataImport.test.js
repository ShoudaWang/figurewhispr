const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { importLegacyUserData } = require("../../src/helpers/legacyUserDataImport");

const quiet = { info() {}, warn() {} };

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figurewhispr-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("the first launch copies the OpenWhispr profile, leaving caches and the account behind", (t) => {
  const root = tempRoot(t);
  const legacy = path.join(root, "open-whispr");
  const target = path.join(root, "FigureWhispr");
  write(path.join(legacy, "Local Storage", "leveldb", "000003.log"), "settings");
  write(path.join(legacy, "Local Storage", "leveldb", "LOCK"));
  write(path.join(legacy, ".env"), "GEMINI_API_KEY=k");
  write(path.join(legacy, "transcriptions.db"), "db");
  write(path.join(legacy, "audio", "a.webm"));
  write(path.join(legacy, "Cache", "data_0"));
  write(path.join(legacy, "auth-token.bin"));
  write(path.join(legacy, "workspace-policy.json"));

  assert.equal(importLegacyUserData(legacy, target, { log: quiet }), "imported");

  const read = (...p) => fs.readFileSync(path.join(target, ...p), "utf8");
  assert.equal(read("Local Storage", "leveldb", "000003.log"), "settings");
  assert.equal(read(".env"), "GEMINI_API_KEY=k");
  assert.equal(read("transcriptions.db"), "db");
  assert.ok(fs.existsSync(path.join(target, "audio", "a.webm")));
  for (const gone of [["Cache"], ["auth-token.bin"], ["workspace-policy.json"]]) {
    assert.equal(fs.existsSync(path.join(target, ...gone)), false, gone.join("/"));
  }
  assert.equal(fs.existsSync(path.join(target, "Local Storage", "leveldb", "LOCK")), false);
  assert.equal(fs.existsSync(`${target}.importing`), false);
  assert.ok(fs.existsSync(path.join(legacy, "auth-token.bin")), "the source is left as it was");
});

test("an existing FigureWhispr profile is never overwritten", (t) => {
  const root = tempRoot(t);
  const legacy = path.join(root, "open-whispr");
  const target = path.join(root, "FigureWhispr");
  write(path.join(legacy, ".env"), "old");
  write(path.join(target, ".env"), "mine");

  assert.equal(importLegacyUserData(legacy, target, { log: quiet }), "existing");
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "mine");
});

test("with no OpenWhispr profile it starts fresh", (t) => {
  const root = tempRoot(t);
  const target = path.join(root, "FigureWhispr");
  assert.equal(importLegacyUserData(path.join(root, "missing"), target, { log: quiet }), "fresh");
  assert.equal(fs.existsSync(target), false);
});

test("a copy interrupted on an earlier launch is redone", (t) => {
  const root = tempRoot(t);
  const legacy = path.join(root, "open-whispr");
  const target = path.join(root, "FigureWhispr");
  write(path.join(legacy, ".env"), "k");
  write(path.join(`${target}.importing`, "partial"));

  assert.equal(importLegacyUserData(legacy, target, { log: quiet }), "imported");
  assert.equal(fs.existsSync(path.join(target, "partial")), false);
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "k");
});
