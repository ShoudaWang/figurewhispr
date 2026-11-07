# Google sign-in and settings sync

FigureWhispr (this fork of OpenWhispr) has no OpenWhispr account. Dictation works with no
sign-in at all, on local models or your own API keys. Signing in with Google is
optional and does one thing: it keeps your settings in sync across your
computers.

## How it works

- Sign-in uses Google's OAuth flow for desktop apps: your browser opens, you
  approve, and Google redirects to a temporary `http://127.0.0.1:<port>`
  listener in FigureWhispr. The refresh token is encrypted with the OS keychain
  (Electron `safeStorage`) under `%APPDATA%\FigureWhispr\google-account\`.
- Settings are stored in a single file, `figurewhispr-settings.json`, in your
  Google Drive's hidden **app data folder** (scope `drive.appdata`). Only this
  OAuth client can read it, and it doesn't appear in your Drive file list.
- What syncs: every preference in Settings (models, providers, prompts,
  dictionary, hotkeys, tone, agent name, UI language). What doesn't: per-device
  paths, onboarding state, and your API keys, unless you turn on
  **Include API keys**.
- When another computer saved newer settings, FigureWhispr applies them and
  restarts so every window picks them up. Local edits upload about 5 seconds
  after you make them. If both sides changed, the most recent save wins.

## One-time setup: create an OAuth client

Google requires every app that signs users in to have its own OAuth client.
Create one in a Google Cloud project you control:

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: choose _Internal_ (Google
   Workspace orgs) or _External_. Add the scopes `openid`, `email`, `profile`
   and `.../auth/drive.appdata`. For _External_ in testing mode, add your
   Google account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Desktop app**.
5. Copy the client ID and client secret. (For desktop apps the "secret" is not
   confidential; Google's PKCE flow is what protects the sign-in.)

Then give them to FigureWhispr, either way:

- **In the app**: Settings → Account → paste the client ID and secret → Save.
- **At build/launch time**: put them in `%APPDATA%\FigureWhispr\.env` (or the
  project's `.env` for development):

  ```
  GOOGLE_OAUTH_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
  GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
  ```

  A client saved in Settings takes precedence over the environment.

## Gemini Ultrafast

Settings → Speech to Text → Dictation → **Gemini Ultrafast** sends the
recording _and_ the cleanup prompt to Gemini in one `generateContent` request,
so the cleaned-up text arrives after a single round trip instead of
transcribe → send transcript → clean up. It uses your Gemini API key, your
cleanup prompt, custom dictionary, language and tone settings. If the request
fails, or the answer can't be a transcript (cut off, or far longer than the
recording), the dictation falls back to your regular transcription and cleanup
setup. Dictations addressed to the voice agent ("Hey <agent name>, …") still
take the agent route after the single-pass transcript.

## Coming from OpenWhispr

FigureWhispr installs as its own app (`ai.figure.figurewhispr`, data in
`%APPDATA%\FigureWhispr`), so it can sit beside a stock OpenWhispr install. On
its first launch it copies the OpenWhispr profile from `%APPDATA%\open-whispr`:
settings, API keys, dictionary, history and recordings. Caches, the OpenWhispr
sign-in and workspace policy stay behind. Downloaded models are shared, not
copied. Both apps can run at once, but only one should own a given hotkey.

## Bringing the OpenWhispr account back

Build with `VITE_ENABLE_OPENWHISPR_ACCOUNTS=true` to restore the original
OpenWhispr account, cloud and workspace features (`src/config/accounts.ts`).
