// FigureWhispr builds without OpenWhispr accounts (src/config/accounts.ts).
// Connectors then run on the user's own logins only: their logins and action
// receipts are filed under one local account, and there is no organization
// policy to fetch, so connector calls are allowed. With accounts enabled the
// OpenWhispr account scope and policy resolver are used unchanged.

const LOCAL_CONNECTOR_SCOPE = Object.freeze({ accountId: "local", authGeneration: 0 });

// Read when called, not at load: main loads its .env files before wiring connectors.
function accountsEnabledFromEnv() {
  return process.env.VITE_ENABLE_OPENWHISPR_ACCOUNTS === "true";
}

function withLocalConnectorScope(getAccountScope, accountsEnabled = accountsEnabledFromEnv()) {
  return accountsEnabled ? getAccountScope : () => LOCAL_CONNECTOR_SCOPE;
}

function withLocalConnectorPolicy(getPolicyState, accountsEnabled = accountsEnabledFromEnv()) {
  return accountsEnabled ? getPolicyState : async () => "allowed";
}

module.exports = {
  LOCAL_CONNECTOR_SCOPE,
  withLocalConnectorScope,
  withLocalConnectorPolicy,
};
