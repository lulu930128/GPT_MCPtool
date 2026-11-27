import { DirectOperationError } from "./direct-operation-error.js";
import { NativeRpcRejected, type AppServerTransport, type JsonRpcNotification } from "./app-server-client.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return typeof value === "object" && value !== null ? value as ObjectValue : {};
}
function nativeId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function statusOf(value: unknown) {
  const type = object(value).type;
  return ["idle", "active", "notLoaded", "systemError"].includes(String(type)) ? String(type) : "unknown";
}

interface ResumeOptions {
  threadId: string;
  priorTurnId?: string;
  cwd: string;
  permissions: string;
  reviewer: "user" | "auto_review";
  model?: string;
  effort?: string;
  action: "turn" | "review" | "compact";
  checkAutomaticWork(): Promise<void>;
  record(data: ObjectValue): Promise<void>;
}

// Thread/read has no permission fields in 0.172. A configured resume is the
// initial settings snapshot. Only a settings transition needs a joined-writer
// readback. Never use resume to discover whether the thread is loaded or busy.
export async function prepareResumedThread(client: AppServerTransport, options: ResumeOptions) {
  const { threadId, priorTurnId, permissions, reviewer, action } = options;
  let phase = "preflight", stage = "profile", notification = "missing", readbacks = 0;
  let status = "unknown", resumeStatus = "unknown", notifiedStatus = "unknown";
  let statusRevision = 0, verifiedRevision = -1;
  let observedSettings: ObjectValue = {};
  let headId: string | undefined, headStatus = "unknown", owner = "unverified";
  let fields: string[] = [];
  let initialStatus = "unknown", directInput: boolean | null = null;
  let invalidated = false, startedTurnId: string | undefined;
  let snapshotVerified = false, settingsChanged = false;
  let wake: (() => void) | undefined;
  const stages: ObjectValue[] = [];
  let expectedProfile: string | null = permissions;
  const settingOverrides = action === "turn" ? {} : {
    ...(options.model && { model: options.model }), ...(options.effort && { effort: options.effort }),
  };
  const sampleSettings = (snapshot: ObjectValue) => {
    const sandbox = object(snapshot.sandbox);
    const known = (value: unknown, allowed: string[]) =>
      value === undefined ? "missing" : allowed.includes(String(value)) ? value : "other";
    return {
      profile: snapshot.activePermissionProfile === null ? null : known(object(snapshot.activePermissionProfile).id,
        [":danger-full-access", "codex-bridge-read-only", "codex-bridge-workspace"]),
      sandbox: known(sandbox.type, ["dangerFullAccess","readOnly","workspaceWrite","externalSandbox"]),
      network: typeof sandbox.networkAccess === "boolean" ? sandbox.networkAccess : null,
      policy: known(snapshot.approvalPolicy, ["never","on-request","on-failure","untrusted"]),
      reviewer: known(snapshot.approvalsReviewer, ["user","auto_review"]),
    };
  };
  const differences = (snapshot: ObjectValue, event = false) => {
    const sandbox = object(snapshot[event ? "sandboxPolicy" : "sandbox"]);
    const actual = snapshot.activePermissionProfile;
    const fields: string[] = [];
    if (expectedProfile === null ? actual !== null : object(actual).id !== expectedProfile) fields.push("profile");
    if (sandbox.type !== (permissions === ":danger-full-access" ? "dangerFullAccess" : "readOnly")) fields.push("sandbox");
    if (permissions !== ":danger-full-access" && sandbox.networkAccess !== true) fields.push("network");
    if (snapshot.approvalPolicy !== "on-request") fields.push("policy");
    if (snapshot.approvalsReviewer !== reviewer) fields.push("reviewer");
    if (settingOverrides.model && snapshot.model !== settingOverrides.model) fields.push("model");
    if (settingOverrides.effort && snapshot[event ? "effort" : "reasoningEffort"] !== settingOverrides.effort) fields.push("effort");
    return fields;
  };
  const failure = (code: string, reason: string) => new DirectOperationError(code,
    `${code}: stage=${stage}; reason=${reason}; fields=${fields.join(",") || "none"}; notification=${notification}; readbacks=${readbacks}`);
  const observe = (message: JsonRpcNotification) => {
    if (message.params?.threadId !== threadId) return;
    if (message.method === "thread/settings/updated") {
      notification = !message.params.threadSettings ? "malformed" :
        differences(object(message.params.threadSettings), true).length ? "mismatched" : "matching";
      if (snapshotVerified && notification !== "matching") {
        settingsChanged = true;
        fields = differences(object(message.params.threadSettings), true);
      }
    }
    if (message.method === "thread/settings/updated" && notification === "matching") wake?.();
    if (message.method === "thread/status/changed") {
      notifiedStatus = statusOf(message.params.status);
      statusRevision++;
    }
    if (message.method === "turn/started") {
      const id = object(message.params.turn).id;
      startedTurnId = nativeId(id);
      invalidated = true;
    }
    if (message.method === "thread/closed") invalidated = true;
  };
  const disconnected = () => { invalidated = true; };
  const assertWriter = () => {
    if (settingsChanged) throw failure("NATIVE_SETTINGS_CHANGED", "settings_changed_after_readback");
    if (startedTurnId) throw failure("NATIVE_TURN_ACTIVE", "turn_started");
    if (verifiedRevision >= 0 && statusRevision > verifiedRevision && ["active","notLoaded","unknown"].includes(notifiedStatus))
      throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "status_changed_during_check");
    if (invalidated || client.status !== "ready") throw failure("NATIVE_OWNER_UNVERIFIED", "writer_changed");
  };
  const latestTurn = async () => {
    try {
      const page = await client.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      if (!Array.isArray(page.data) || page.data.length > 1 || (!page.data.length && page.nextCursor !== null))
        throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "invalid_turn_page");
      return page.data[0];
    } catch (error) {
      // The legacy history backend has no list_turns implementation. Only
      // method-not-supported allows the official exact-thread legacy read.
      if (!(error instanceof Error && error.message.includes("list_turns is not supported") && error.message.includes("(-32601)"))) throw error;
      assertWriter();
      const thread = object((await client.request("thread/read", {threadId, includeTurns:true})).thread);
      if (thread.id !== threadId || !Array.isArray(thread.turns)) throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "invalid_legacy_history");
      return thread.turns.find(turn => object(turn).status === "inProgress") ?? thread.turns.at(-1);
    }
  };
  const checkHead = async () => {
    assertWriter();
    const revisionBeforeRead = statusRevision;
    const [read, latest] = await Promise.all([
      client.request("thread/read", { threadId, includeTurns: false }),
      latestTurn(),
    ]);
    assertWriter();
    const thread = object(read.thread);
    if (thread.id !== threadId) throw failure("NATIVE_THREAD_IDENTITY_MISMATCH", "read_thread_mismatch");
    verifiedRevision = revisionBeforeRead;
    status = statusOf(thread.status);
    directInput = typeof thread.canAcceptDirectInput === "boolean" ? thread.canAcceptDirectInput : null;
    const head = object(latest);
    headId = nativeId(head.id);
    headStatus = ["completed","failed","interrupted","inProgress"].includes(String(head.status)) ? String(head.status) : "unknown";
    if (headStatus === "inProgress") throw failure("NATIVE_TURN_ACTIVE", "in_progress");
    if (resumeStatus === "active" || status === "active") throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "active_without_confirmed_turn");
    if (latest !== undefined && (!headId || headStatus === "unknown")) throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "unknown_head");
    if (priorTurnId && priorTurnId !== headId) throw failure("NATIVE_THREAD_HEAD_CHANGED", "prior_turn_mismatch");
    if (status === "notLoaded" || status === "unknown")
      throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "writer_not_loaded");
    if (directInput !== true || owner !== "resumed_writer")
      throw failure("NATIVE_OWNER_UNVERIFIED", "direct_input_unconfirmed");
    if (status !== "idle" && !(status === "systemError" && headId && headId === priorTurnId && headStatus === "failed"))
      throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "terminal_head_unconfirmed");
  };
  const inspectResume = (response: ObjectValue) => {
    const thread = object(response.thread);
    if (thread.id !== threadId) throw failure("NATIVE_THREAD_IDENTITY_MISMATCH", "resume_thread_mismatch");
    resumeStatus = statusOf(thread.status);
    if (resumeStatus === "unknown") throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "unknown_resume_status");
  };
  // Keep the existing confirmation deadline. Never retry a mutation. A stale
  // settings read is the only reason to sample again, after passive checks.
  const update = async (params: ObjectValue, profile: string | null) => {
    stage = profile === null ? "sandbox" : "profile";
    snapshotVerified = false;
    expectedProfile = profile;
    notification = "missing";
    readbacks = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(failure(phase === "poll" ? "PERMISSION_PROFILE_UNVERIFIED" : "NATIVE_SETTINGS_TRANSPORT_UNVERIFIED",
          phase === "poll" ? "readback_mismatch" : phase + "_timeout"));
      }, 5000);
    });
    const within = <T>(request: Promise<T>) => Promise.race([deadline, request]);
    try {
      phase = "update";
      assertWriter();
      await within(client.request("thread/settings/update", { threadId, ...params, ...settingOverrides,
        approvalPolicy: "on-request", approvalsReviewer: reviewer }));
      for (;;) {
        phase = "readback";
        await within(options.checkAutomaticWork());
        await within(checkHead());
        assertWriter();
        let appliedDuringRead = false;
        wake = () => { appliedDuringRead = true; };
        readbacks++;
        const response = await within(client.request("thread/resume", { threadId, excludeTurns: true }));
        inspectResume(response);
        observedSettings = sampleSettings(response);
        fields = differences(response);
        snapshotVerified = fields.length === 0;
        await within(checkHead());
        if (!fields.length) {
          stages.push({stage, notification, readbacks, status, resumeStatus, observedSettings, fields: []});
          return;
        }
        phase = "poll";
        // A notification wakes a stale sample immediately. A lost notification
        // still permits bounded readback, with decreasing frequency. No action
        // or settings/update is resubmitted.
        if (!appliedDuringRead) {
          let tick: ReturnType<typeof setTimeout> | undefined;
          try {
            await within(new Promise<void>(resolve => {
              wake = resolve;
              tick = setTimeout(resolve, Math.min(100 * 2 ** (readbacks - 1), 1000));
            }));
          } finally { clearTimeout(tick); wake = undefined; }
        }
      }
    } catch (error) {
      if (error instanceof DirectOperationError || expired) throw error;
      if (error instanceof Error && /already has an active writer/i.test(error.message)) {
        owner = "other_writer";
        throw failure("NATIVE_OTHER_WRITER", "writer_conflict");
      }
      throw failure(error instanceof NativeRpcRejected ? "NATIVE_SETTINGS_REJECTED" : "NATIVE_SETTINGS_TRANSPORT_UNVERIFIED", phase + "_failed");
    } finally { clearTimeout(timer); wake = undefined; }
  };

  const evidence = () => ({ threadId, priorTurnId, action, phase, stage, status, resumeStatus, notifiedStatus,
    initialStatus, observedSettings, headId, headStatus, startedTurnId, owner, directInput, notification, readbacks,
    stages: [...stages], fields: [...fields], expectedProfile, reviewer });
  client.on("notification", observe);
  client.on("exit", disconnected);
  try {
    verifiedRevision = statusRevision;
    const before = object((await client.request("thread/read", { threadId, includeTurns: false })).thread);
    if (before.id !== threadId) throw failure("NATIVE_THREAD_IDENTITY_MISMATCH", "read_thread_mismatch");
    initialStatus = status = statusOf(before.status);
    if (status === "unknown") throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "unknown_initial_status");
    if (status === "active") {
      await checkHead();
      throw failure("NATIVE_THREAD_STATUS_UNSETTLED", "active_before_resume");
    }
    await options.checkAutomaticWork();
    phase = "resume";
    assertWriter();
    const response = await client.request("thread/resume", { threadId, excludeTurns: true, cwd: options.cwd,
      runtimeWorkspaceRoots: [options.cwd], approvalPolicy: "on-request", approvalsReviewer: reviewer, permissions,
      serviceName: "codex-handoff-bridge", ...(options.model && {model:options.model}),
      ...(options.effort && {config:{model_reasoning_effort:options.effort}}) });
    inspectResume(response);
    owner = "resumed_writer";
    phase = "inspect";
    observedSettings = sampleSettings(response);
    fields = differences(response);
    snapshotVerified = fields.length === 0;
    stages.push({stage:"resume", status:resumeStatus, observedSettings, fields:[...fields]});
    if (fields.length) {
      await checkHead();
      if (permissions === ":danger-full-access" && object(response.sandbox).type !== "dangerFullAccess")
        await update({ sandboxPolicy: { type: "dangerFullAccess" } }, null);
      await update({ permissions }, permissions);
    }
    phase = "authorize";
    await options.checkAutomaticWork();
    await checkHead();
    await options.record({ ...evidence(), outcome: "settings_verified" });
    assertWriter();
  } catch (error) {
    let classified: DirectOperationError;
    if (error instanceof DirectOperationError) classified = error;
    else if (phase === "resume" && error instanceof Error && /already has an active writer/i.test(error.message)) {
      owner = "other_writer"; classified = failure("NATIVE_OTHER_WRITER", "writer_conflict");
    } else if (phase === "resume" && error instanceof Error &&
      /^Model [A-Za-z0-9_.-]+ is (not authorized|not available|not supported)$/.test(error.message)) {
      classified = new DirectOperationError("NATIVE_MODEL_REJECTED", error.message);
    } else classified = failure(error instanceof NativeRpcRejected ? "NATIVE_RPC_REJECTED" : "NATIVE_THREAD_TRANSPORT_UNVERIFIED", phase + "_failed");
    await options.record({ ...evidence(), outcome: "action_not_sent", code: classified.code });
    throw classified;
  } finally {
    client.off("notification", observe);
    client.off("exit", disconnected);
  }
}
