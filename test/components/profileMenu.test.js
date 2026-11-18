const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadProfileMenu(t, { accountsEnabled = true } = {}) {
  t.after(() => {
    delete globalThis.__google;
    delete globalThis.__auth;
    delete globalThis.__menuItems;
    delete globalThis.__planLabel;
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-profile-menu-",
    mockModules: {
      "/hooks/useAuth": "export const useAuth = () => globalThis.__auth;",
      "/hooks/useUsage": "export const useUsage = () => null;",
      "/hooks/useAccountPlan":
        "export const useAccountPlan = () => ({ planLabel: globalThis.__planLabel ?? null });",
      "/hooks/useGoogleAccountStatus":
        "export const useGoogleAccountStatus = () => globalThis.__google ?? null;",
      "/config/accounts.ts": `export const ACCOUNTS_ENABLED = ${accountsEnabled};`,
      "/MemberAvatar": `
        import React from "react";
        export default function MemberAvatar({ image }) {
          return React.createElement("img", { "data-avatar": image ?? "initials" });
        }
      `,
      // Renders the menu open and records each item's handler under its text.
      "/ui/dropdown-menu": `
        import React from "react";
        const textOf = (node) =>
          typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : "";
        export const DropdownMenu = ({ children }) => children;
        export const DropdownMenuTrigger = ({ children, ...props }) =>
          React.createElement("button", props, children);
        export const DropdownMenuContent = ({ children }) => React.createElement("div", null, children);
        export const DropdownMenuSeparator = () => null;
        export const DropdownMenuItem = ({ children, onSelect }) => {
          globalThis.__menuItems.set(textOf(children), onSelect);
          return null;
        };
      `,
    },
  });
  const { default: ProfileMenu } = await vite.ssrLoadModule("/components/ProfileMenu.tsx");
  const opened = [];
  const render = (auth, google) => {
    globalThis.__auth = auth;
    globalThis.__google = google;
    globalThis.__menuItems = new Map();
    return renderToStaticMarkup(
      createElement(ProfileMenu, {
        onOpenSettings: (section) => opened.push(section),
        onOpenReferrals: () => opened.push("referrals"),
        onSignOut: () => opened.push("sign out"),
      })
    );
  };
  return { render, opened };
}

test("a session still loading shows neither Sign in nor an account", async (t) => {
  const { render } = await loadProfileMenu(t);

  const markup = render({ isLoaded: false, isSignedIn: false, user: null });

  assert.doesNotMatch(markup, /<button/);
});

test("signed out, the avatar offers Sign in", async (t) => {
  const { render } = await loadProfileMenu(t);

  const markup = render({ isLoaded: true, isSignedIn: false, user: null });

  assert.match(markup, /aria-label="common\.signIn"/);
});

const signedIn = {
  isLoaded: true,
  isSignedIn: true,
  user: { name: "Chad Piha", email: "chad@example.com", image: null },
};

test("the menu holds the account's own actions, ending with Sign out", async (t) => {
  const { render, opened } = await loadProfileMenu(t);

  render(signedIn);
  const labels = [...globalThis.__menuItems.keys()];
  for (const label of labels) globalThis.__menuItems.get(label)();

  assert.deepEqual(labels, [
    "settingsModal.sections.account.label",
    "settingsModal.sections.plansBilling.label",
    "sidebar.referral",
    "settingsPage.account.signOut.signOut",
  ]);
  assert.deepEqual(opened, ["account", "plansBilling", "referrals", "sign out"]);
});

test("the header names the plan once it is known", async (t) => {
  const { render } = await loadProfileMenu(t);

  assert.doesNotMatch(render(signedIn), />Pro</);

  globalThis.__planLabel = "Pro";
  assert.match(render(signedIn), />Pro</);
});

test("an account presented offline says so in place of the plan", async (t) => {
  const { render } = await loadProfileMenu(t);
  globalThis.__planLabel = "Pro";

  const markup = render({ ...signedIn, isOfflineAccount: true });

  assert.match(markup, />settingsPage\.account\.offline</);
  assert.doesNotMatch(markup, />Pro</);
});

// Without OpenWhispr accounts the profile is the Google account from Settings → Account.
const google = (status) => ({
  configured: true,
  clientSource: "settings",
  signedIn: false,
  email: null,
  name: null,
  picture: null,
  ...status,
});

test("without accounts, the Google status still loading holds the slot", async (t) => {
  const { render } = await loadProfileMenu(t, { accountsEnabled: false });

  const markup = render(undefined, null);

  assert.doesNotMatch(markup, /<button/);
});

test("without accounts, signed out of Google, the avatar offers Sign in", async (t) => {
  const { render, opened } = await loadProfileMenu(t, { accountsEnabled: false });

  const markup = render(undefined, google({ signedIn: false }));

  assert.match(markup, /aria-label="common\.signIn"/);
  assert.doesNotMatch(markup, /data-avatar/);
  assert.deepEqual(opened, []);
});

test("signed in to Google, the header shows the Google profile photo", async (t) => {
  const { render, opened } = await loadProfileMenu(t, { accountsEnabled: false });
  const photo = "https://lh3.googleusercontent.com/a/photo=s96-c";

  const markup = render(
    undefined,
    google({ signedIn: true, name: "Ada Lovelace", email: "ada@example.com", picture: photo })
  );

  assert.ok(markup.includes(`data-avatar="${photo}"`), markup);
  assert.match(markup, /Ada Lovelace/);
  assert.match(markup, /ada@example\.com/);
  assert.deepEqual(
    [...globalThis.__menuItems.keys()],
    ["settingsModal.sections.account.label", "googleAccount.signOut"]
  );
  globalThis.__menuItems.get("settingsModal.sections.account.label")();
  assert.deepEqual(opened, ["account"]);
});
