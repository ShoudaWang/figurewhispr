# Connectors in FigureWhispr

FigureWhispr has no OpenWhispr account or plan. Its Integrations page lists
**Calendars**, **Skills** and the **command line** (local mode,
`openwhispr --local …`). It doesn't list OpenWhispr's cloud developer features
(**API keys**, the hosted **MCP server**), which need an OpenWhispr account, or
**Connectors**, whose Slack, Linear, GitHub and Gmail logins need OAuth apps
that only OpenWhispr's release builds ship.

The assistant can still draft email (below), and never offers to connect the
others. The Connectors settings come back only in a build with OpenWhispr
accounts (`VITE_ENABLE_OPENWHISPR_ACCOUNTS=true`), where they also need an
OpenWhispr paid plan (`CONNECTOR_SETTINGS_ENABLED` in `src/config/accounts.ts`).
The notes below are kept for reference: how to give those logins your own
OAuth apps. Their values go in `%APPDATA%\FigureWhispr\.env` (one `NAME=value`
per line); quit and reopen FigureWhispr afterwards.

## Email drafts

Works without setup in every build: when you ask the assistant to email
someone, it opens a pre-filled draft in your mail app.

## Gmail (send email from chat)

In your Google Cloud project (the one used for Google sign-in works):

1. **APIs & Services → Library**: enable the **Gmail API**.
2. **Google Auth Platform → Data Access**: add the scope
   `https://www.googleapis.com/auth/gmail.send`. It is a sensitive scope: an
   _Internal_ audience needs no review; _External_ works for test users only.
3. **Clients → Create client**, type **Desktop app**. Copy the ID and secret.

```
GMAIL_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-...
```

Disconnecting Gmail revokes your grant to that Cloud project, which can also
end the Google sign-in used for settings sync if both use the same project;
sign in again under Settings → Account if that happens.

## GitHub (search issues, create issues, comment)

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Any homepage URL; leave the callback URL empty; tick **Enable Device
   Flow**; turn **Webhook** off.
3. Repository permissions: **Issues: Read and write**, **Pull requests: Read
   and write** (comments on pull requests), **Metadata: Read-only**.
4. Create it, then **Install App** on the repositories the assistant may use.

```
GITHUB_APP_CLIENT_ID=Iv23li...
GITHUB_APP_SLUG=your-app-name
```

The slug (from the App's URL) lets FigureWhispr link to "choose repositories".
No client secret is needed: device-flow tokens refresh with the client ID.

## Slack and Linear

Both redirect their sign-in through an https page OpenWhispr hosts. They need
your own Slack or Linear OAuth app plus your own https redirect page
(`SLACK_CLIENT_ID` + `SLACK_OAUTH_REDIRECT_URI`, `LINEAR_CLIENT_ID` +
`LINEAR_OAUTH_REDIRECT_URI`). Until then Slack shows "isn't available in this
build" and Linear stays hidden.
