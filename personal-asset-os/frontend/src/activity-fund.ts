import type { Account } from "./types";

export function isActivityFundAccount(account: Account): boolean {
  return (
    !account.is_system &&
    account.is_active &&
    account.is_liquid &&
    account.kind === "asset" &&
    account.currency === "TWD" &&
    (account.subtype === "cash" || account.subtype === "bank")
  );
}

export function activityFundCandidates(accounts: Account[]): Account[] {
  return accounts.filter(isActivityFundAccount);
}
