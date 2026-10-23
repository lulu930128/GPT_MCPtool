/** Isolated composition only. Owned by the test caller; no daemon, startup, tray mutation,
 * credentials, approval journal, lifecycle commands or autonomous process launcher.
 * A future protected Tray runspace must host the same canonical authority, not clone its data.
 * Runtime dependencies are injected ONLY by the isolated harness; never from MCP or IPC. */
export async function startIsolatedNormalMarkerOperator({ protocol, keys, bridgePublicKey, claim, runner }) {
  const listener = await protocol.listenIsolatedOperator({ keys, bridgePublicKey, claim, runner });
  return Object.freeze({ ...listener, evidence: "ISOLATED_IPC_ONLY", outOfJob: "UNVERIFIED" });
}

/** Deliberately unconditional: booleans/env/config cannot claim OS/ACL acceptance. */
export function startProductionNormalMarkerOperator() {
  throw new Error("BLOCKED_HOST_ACCEPTANCE");
}
