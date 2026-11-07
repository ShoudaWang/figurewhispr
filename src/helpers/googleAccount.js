// Google account sign-in and settings storage (replaces the OpenWhispr account).
//
// Sign-in is an OAuth 2.0 authorization-code flow with PKCE over a loopback
// redirect (http://127.0.0.1:<random port>/callback), the flow Google documents
// for installed apps. It needs an OAuth client of type "Desktop app" from the
// user's own Google Cloud project; see docs/GOOGLE_SIGN_IN.md.
//
// Settings live in the app's hidden Drive "appDataFolder" (scope
// drive.appdata): only this OAuth client can see that file, and it never shows
// up in the user's Drive file list.

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { app, net, safeStorage, ipcMain } = require("electron");
const debugLogger = require("./debugLogger");
const { openExternalUrl } = require("./externalUrlOpener");
const { broadcastToWindows } = require("./windowBroadcast");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.appdata"];
const SETTINGS_FILE_NAME = "figurewhispr-settings.json";
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const STATUS_EVENT = "google-account-status-changed";

function storageDir() {
  return path.join(app.getPath("userData"), "google-account");
}

function ensureStorageDir() {
  fs.mkdirSync(storageDir(), { recursive: true, mode: 0o700 });
}

function writeFileAtomic(target, data) {
  ensureStorageDir();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// --- OAuth client configuration ---------------------------------------------

const clientConfigPath = () => path.join(storageDir(), "client.json");

function readSavedClientConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(clientConfigPath(), "utf8"));
    return {
      clientId: typeof parsed.clientId === "string" ? parsed.clientId.trim() : "",
      clientSecret: typeof parsed.clientSecret === "string" ? parsed.clientSecret.trim() : "",
    };
  } catch {
    return { clientId: "", clientSecret: "" };
  }
}

/** The client the user saved in Settings wins over one baked in through the environment. */
function getClientConfig() {
  const saved = readSavedClientConfig();
  if (saved.clientId) return { ...saved, source: "settings" };
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  return { clientId, clientSecret, source: clientId ? "environment" : "none" };
}

function saveClientConfig({ clientId, clientSecret } = {}) {
  const id = typeof clientId === "string" ? clientId.trim() : "";
  const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
  if (!id) {
    try {
      fs.unlinkSync(clientConfigPath());
    } catch {}
    return;
  }
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error(
      "That does not look like a Google OAuth client ID (…apps.googleusercontent.com)."
    );
  }
  writeFileAtomic(clientConfigPath(), JSON.stringify({ clientId: id, clientSecret: secret }));
}

// --- Token storage (encrypted with the OS keychain via safeStorage) -----------

const tokenPath = () => path.join(storageDir(), "account.bin");

function readAccount() {
  try {
    const raw = fs.readFileSync(tokenPath());
    const json =
      raw[0] === 0x7b /* "{" */ || !safeStorage.isEncryptionAvailable()
        ? raw.toString("utf8")
        : safeStorage.decryptString(raw);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed.refreshToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeAccount(account) {
  const json = JSON.stringify(account);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf8");
  writeFileAtomic(tokenPath(), data);
}

function deleteAccount() {
  try {
    fs.unlinkSync(tokenPath());
  } catch {}
}

function publicStatus() {
  const account = readAccount();
  const client = getClientConfig();
  return {
    configured: Boolean(client.clientId),
    clientSource: client.source,
    signedIn: Boolean(account),
    email: account?.email ?? null,
    name: account?.name ?? null,
    picture: account?.picture ?? null,
  };
}

function broadcastStatus() {
  broadcastToWindows(STATUS_EVENT, publicStatus());
}

// --- HTTP helpers --------------------------------------------------------------

async function request(url, init = {}) {
  const response = await net.fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response;
}

async function postForm(url, params) {
  const response = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const err = new Error(data.error_description || data.error || `HTTP ${response.status}`);
    err.code = data.error || `HTTP_${response.status}`;
    throw err;
  }
  return data;
}

function decodeIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

// --- Sign-in -------------------------------------------------------------------

const RESULT_PAGE = (title, message) => `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;
justify-content:center;height:100vh;margin:0;background:#f6f6f7;color:#1d1d1f}main{text-align:center;
max-width:420px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#6e6e73;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

let activeSignIn = null;

function signIn() {
  if (activeSignIn) return activeSignIn.promise;
  const { clientId, clientSecret } = getClientConfig();
  if (!clientId) {
    return Promise.reject(
      Object.assign(new Error("Add a Google OAuth client ID first."), { code: "NOT_CONFIGURED" })
    );
  }

  const state = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  let server = null;
  let timer = null;
  const entry = {};
  entry.promise = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      server?.close();
      activeSignIn = null;
      if (error) reject(error);
      else resolve(value);
    };

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const send = (status, title, message) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(RESULT_PAGE(title, message));
      };
      if (url.searchParams.get("state") !== state) {
        send(400, "Sign-in failed", "The sign-in response did not match this request.");
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        send(400, "Sign-in cancelled", "You can close this tab and return to FigureWhispr.");
        finish(
          Object.assign(new Error(`Google sign-in failed: ${oauthError}`), { code: oauthError })
        );
        return;
      }
      const code = url.searchParams.get("code");
      try {
        const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const tokens = await postForm(TOKEN_URL, {
          code,
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: verifier,
        });
        if (!tokens.refresh_token) {
          throw new Error("Google did not return a refresh token. Try signing in again.");
        }
        const scopes = String(tokens.scope || "").split(/\s+/);
        if (!scopes.includes("https://www.googleapis.com/auth/drive.appdata")) {
          throw Object.assign(
            new Error("Allow FigureWhispr to store its settings in Google Drive to enable sync."),
            { code: "SCOPE_DENIED" }
          );
        }
        const profile = decodeIdToken(tokens.id_token || "");
        writeAccount({
          email: profile.email || null,
          name: profile.name || null,
          picture: profile.picture || null,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        });
        send(200, "Signed in", "You can close this tab and return to FigureWhispr.");
        broadcastStatus();
        finish(null, publicStatus());
      } catch (error) {
        debugLogger.warn("Google sign-in failed", { error: error.message }, "google-account");
        send(500, "Sign-in failed", "Return to FigureWhispr for details.");
        finish(error);
      }
    });

    server.on("error", (error) => finish(error));
    server.listen(0, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      openExternalUrl(`${AUTH_URL}?${params.toString()}`).catch((error) => finish(error));
    });
    timer = setTimeout(
      () => finish(Object.assign(new Error("Google sign-in timed out."), { code: "TIMEOUT" })),
      SIGN_IN_TIMEOUT_MS
    );
    entry.cancel = () =>
      finish(Object.assign(new Error("Google sign-in cancelled."), { code: "CANCELLED" }));
  });
  activeSignIn = entry;
  return entry.promise;
}

function cancelSignIn() {
  activeSignIn?.cancel?.();
}

async function signOut() {
  const account = readAccount();
  deleteAccount();
  broadcastStatus();
  if (account?.refreshToken) {
    // Best effort: the local copy is gone either way.
    await postForm(REVOKE_URL, { token: account.refreshToken }).catch(() => {});
  }
  return publicStatus();
}

let refreshing = null;

async function getAccessToken() {
  const account = readAccount();
  if (!account) {
    throw Object.assign(new Error("Not signed in to Google."), { code: "NOT_SIGNED_IN" });
  }
  if (account.accessToken && account.expiresAt - 60_000 > Date.now()) return account.accessToken;
  if (!refreshing) {
    refreshing = (async () => {
      const { clientId, clientSecret } = getClientConfig();
      try {
        const tokens = await postForm(TOKEN_URL, {
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          refresh_token: account.refreshToken,
          grant_type: "refresh_token",
        });
        const next = {
          ...account,
          accessToken: tokens.access_token,
          expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        };
        writeAccount(next);
        return next.accessToken;
      } catch (error) {
        if (error.code === "invalid_grant") {
          // Revoked or expired: the user has to sign in again.
          deleteAccount();
          broadcastStatus();
        }
        throw error;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

async function driveFetch(url, init = {}) {
  const token = await getAccessToken();
  const response = await request(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw Object.assign(new Error(`Google Drive request failed (${response.status})`), {
      code: `HTTP_${response.status}`,
      body: body.slice(0, 500),
    });
  }
  return response;
}

async function findSettingsFile() {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name='${SETTINGS_FILE_NAME}' and trashed=false`,
    fields: "files(id,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: "10",
  });
  const response = await driveFetch(`${DRIVE_FILES_URL}?${params.toString()}`);
  const data = await response.json();
  return data.files?.[0] ?? null;
}

/** Returns the stored settings document, or null when none has been uploaded yet. */
async function readRemoteSettings() {
  const file = await findSettingsFile();
  if (!file) return null;
  const response = await driveFetch(`${DRIVE_FILES_URL}/${file.id}?alt=media`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeRemoteSettings(document) {
  if (!document || typeof document !== "object") throw new Error("Invalid settings document");
  const body = JSON.stringify(document);
  const file = await findSettingsFile();
  if (file) {
    await driveFetch(`${DRIVE_UPLOAD_URL}/${file.id}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { success: true };
  }
  const boundary = `openwhispr-${crypto.randomBytes(8).toString("hex")}`;
  const metadata = JSON.stringify({
    name: SETTINGS_FILE_NAME,
    parents: ["appDataFolder"],
    mimeType: "application/json",
  });
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  await driveFetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  return { success: true };
}

function deviceId() {
  const target = path.join(storageDir(), "device-id");
  try {
    const existing = fs.readFileSync(target, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const id = crypto.randomUUID();
  try {
    writeFileAtomic(target, id);
  } catch {}
  return id;
}

// --- IPC -------------------------------------------------------------------------

const toResult = (fn) => async (_event, payload) => {
  try {
    return { success: true, data: await fn(payload) };
  } catch (error) {
    return { success: false, error: error?.message || String(error), code: error?.code || null };
  }
};

function registerGoogleAccountIpc() {
  ipcMain.handle(
    "google-account-status",
    toResult(async () => publicStatus())
  );
  ipcMain.handle(
    "google-account-client-config",
    toResult(async () => {
      const { clientId, source, clientSecret } = getClientConfig();
      return { clientId, hasClientSecret: Boolean(clientSecret), source };
    })
  );
  ipcMain.handle(
    "google-account-save-client-config",
    toResult(async (config) => {
      saveClientConfig(config);
      broadcastStatus();
      return publicStatus();
    })
  );
  ipcMain.handle(
    "google-account-sign-in",
    toResult(() => signIn())
  );
  ipcMain.handle(
    "google-account-cancel-sign-in",
    toResult(async () => cancelSignIn())
  );
  ipcMain.handle(
    "google-account-sign-out",
    toResult(() => signOut())
  );
  ipcMain.handle(
    "google-account-read-settings",
    toResult(() => readRemoteSettings())
  );
  ipcMain.handle(
    "google-account-write-settings",
    toResult((doc) => writeRemoteSettings(doc))
  );
  ipcMain.handle(
    "google-account-device-id",
    toResult(async () => deviceId())
  );
}

module.exports = {
  registerGoogleAccountIpc,
  getClientConfig,
  publicStatus,
  STATUS_EVENT,
};
