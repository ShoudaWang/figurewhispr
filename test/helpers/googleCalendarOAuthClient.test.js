const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Google Calendar uses OpenWhispr's baked-in client when a build has one, and
// otherwise the Desktop client saved for Google sign-in (Settings → Account).
let signInClient = { clientId: "", clientSecret: "" };
let lastFlow = null;
const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return { net: {} };
  if (request === "./oauthLoopbackFlow") {
    return {
      runOAuthLoopbackFlow: (options) => {
        lastFlow = options;
        return Promise.resolve(
          options.buildAuthUrl("http://127.0.0.1:1234/callback", "state", "challenge")
        );
      },
      OAuthFlowError: class extends Error {},
    };
  }
  if (request === "./googleAccount") return { getClientConfig: () => ({ ...signInClient }) };
  return originalLoad.call(this, request, parent, isMain);
};
const GoogleCalendarOAuth = require("../../src/helpers/googleCalendarOAuth");
// googleAccount is required lazily, at connect time, so the stubs stay until the file ends.
test.after(() => {
  Module._load = originalLoad;
});

function withEnv(env, run) {
  const saved = {
    id: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
  };
  const set = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set("GOOGLE_CALENDAR_CLIENT_ID", env.id);
  set("GOOGLE_CALENDAR_CLIENT_SECRET", env.secret);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      set("GOOGLE_CALENDAR_CLIENT_ID", saved.id);
      set("GOOGLE_CALENDAR_CLIENT_SECRET", saved.secret);
    });
}

test("without a baked-in client, Calendar signs in with the Google sign-in client", () =>
  withEnv({}, async () => {
    signInClient = {
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: "sign-in-secret",
    };
    const oauth = new GoogleCalendarOAuth({});
    assert.equal(oauth.getClientId(), "123-abc.apps.googleusercontent.com");
    assert.equal(oauth.getClientSecret(), "sign-in-secret");
    const url = new URL(await oauth.startOAuthFlow());
    assert.equal(url.searchParams.get("client_id"), "123-abc.apps.googleusercontent.com");
  }));

test("a baked-in Calendar client wins, with its own secret", () =>
  withEnv({ id: "calendar.apps.googleusercontent.com", secret: "calendar-secret" }, () => {
    signInClient = {
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: "sign-in-secret",
    };
    const oauth = new GoogleCalendarOAuth({});
    assert.equal(oauth.getClientId(), "calendar.apps.googleusercontent.com");
    assert.equal(oauth.getClientSecret(), "calendar-secret");
  }));

test("with no client at all, connecting fails before opening Google", () =>
  withEnv({}, () => {
    signInClient = { clientId: "", clientSecret: "" };
    const oauth = new GoogleCalendarOAuth({});
    assert.equal(oauth.getClientId(), undefined);
    assert.throws(() => oauth.startOAuthFlow(), /Settings → Account/);
  }));

test("without OpenWhispr accounts the browser lands on a local page, never openwhispr.com", () =>
  withEnv({}, async () => {
    const saved = process.env.VITE_ENABLE_OPENWHISPR_ACCOUNTS;
    try {
      signInClient = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "" };
      delete process.env.VITE_ENABLE_OPENWHISPR_ACCOUNTS;
      await new GoogleCalendarOAuth({}).startOAuthFlow();
      assert.equal(typeof lastFlow.renderResultPage, "function");

      // An accounts build keeps OpenWhispr's hosted desktop-callback page.
      process.env.VITE_ENABLE_OPENWHISPR_ACCOUNTS = "true";
      await new GoogleCalendarOAuth({}).startOAuthFlow();
      assert.equal(lastFlow.renderResultPage, null);
    } finally {
      if (saved === undefined) delete process.env.VITE_ENABLE_OPENWHISPR_ACCOUNTS;
      else process.env.VITE_ENABLE_OPENWHISPR_ACCOUNTS = saved;
    }
  }));

test("the calendar result page reads its copy from integrations.<provider>.browser", () => {
  const { calendarResultPage } = require("../../src/helpers/connectors/oauthResultPage");
  const i18n = { t: (key) => `<${key}>` };
  const page = calendarResultPage("integrations.googleCalendar", { env: {}, i18n });
  const ok = page({ ok: true });
  assert.match(ok, /integrations\.googleCalendar\.browser\.connectedTitle/);
  assert.match(ok, /data-ok="true"/);
  assert.doesNotMatch(ok, /<integrations/, "copy is HTML-escaped");
  assert.match(page({ ok: false }), /integrations\.googleCalendar\.browser\.failedBody/);
  assert.equal(
    calendarResultPage("integrations.googleCalendar", {
      env: { VITE_ENABLE_OPENWHISPR_ACCOUNTS: "true" },
      i18n,
    }),
    null
  );
});
