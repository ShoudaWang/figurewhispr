import type { UsageState } from "../lib/usageStore";
import { ACCOUNTS_ENABLED } from "../config/accounts.ts";

/**
 * Connectors are paid-only (subscription or trial, like useUsage's
 * hasPaidAccess). Usage data is only loaded while a surface mounts useUsage(),
 * so other windows (the voice assistant) pass the persisted isSubscribed flag,
 * which the API also sets for trials.
 */
export function hasConnectorPlan(usage: UsageState, isSubscribedFlag: boolean): boolean {
  if (usage.status === "success") return usage.data.isSubscribed || usage.data.isTrial;
  return isSubscribedFlag;
}

/**
 * Whether connectors are open to this user. Connectors run in the app on the
 * user's own logins, so without OpenWhispr accounts (FigureWhispr's default
 * build) there is no plan to check and they are always open. With accounts,
 * they need a signed-in paid plan.
 */
export function hasConnectorAccess(
  isSignedIn: boolean,
  usage: UsageState,
  isSubscribedFlag: boolean,
  accountsEnabled: boolean = ACCOUNTS_ENABLED
): boolean {
  if (!accountsEnabled) return true;
  return isSignedIn && hasConnectorPlan(usage, isSubscribedFlag);
}
