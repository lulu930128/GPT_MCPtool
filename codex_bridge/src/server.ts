import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BridgeRuntime } from "./runtime.js";
import type { BridgeStatus, JobSnapshot } from "./types.js";
import { previewWorkPackage } from "./work-package.js";

const WIDGET_URI = "ui://codex-bridge/chat-workspace-v3.html";

const workPackageInput = {
  projectId: z.string().min(2).max(32),
  title: z.string().min(1).max(120),
  objective: z.string().min(1).max(4_000),
  context: z.string().max(60_000).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(20).optional(),
  constraints: z.array(z.string().min(1).max(2_000)).max(20).optional(),
  executionMode: z.enum(["plan", "workspace_write"]).optional(),
  dataClassification: z.enum(["personal", "public", "company_approved"]).optional(),
  model: z.string().min(1).max(120).optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  inputBundleIds: z.array(z.string().uuid()).max(8).optional(),
};

export function createCodexBridgeMcpServer(runtime: BridgeRuntime): McpServer {
  const server = new McpServer(
    { name: "codex-handoff-bridge", version: "1.1.0" },
    {
      instructions:
        "Private, allowlisted handoff bridge to a local Codex App Server. Use read tools to inspect status and preview work. Render codex_console when the user wants the interactive control surface. Dispatch, steering, cancellation, and approval decisions are UI-only and require an explicit user action. Never represent this bridge as a way to bypass employer policy or upload controls.",
    },
  );

  registerAppResource(server, "codex-console", WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: runtime.widgetHtml,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          "openai/widgetDescription": "Private Codex chat workspace with project-scoped conversations and per-action approvals.",
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
        },
      },
    ],
  }));

  server.registerTool(
    "codex_bridge_status",
    {
      title: "Codex bridge status",
      description: "Inspect whether the private home bridge is online and list allowlisted project ids and recent jobs.",
      annotations: readAnnotations(),
      inputSchema: {},
    },
    async () => safeResult(async () => result(await bridgeStatus(runtime), "Codex bridge status loaded.")),
  );

  server.registerTool(
    "codex_job_preview",
    {
      title: "Preview Codex work package",
      description:
        "Normalize and preview a proposed Codex task without starting it. Use before rendering the console for a new handoff.",
      annotations: readAnnotations(),
      inputSchema: workPackageInput,
    },
    async (args) => safeResult(async () => {
      requireAllowedProject(runtime, args.projectId);
      const preview = previewWorkPackage(args);
      return result(preview, `Prepared a preview for ${preview.workPackage.title}. No job was started.`);
    }),
  );

  registerAppTool(
    server,
    "render_codex_console",
    {
      title: "Open Codex console",
      description:
        "Render the interactive private Codex console to review a draft, dispatch it, monitor work, and answer approvals.",
      annotations: readAnnotations(),
      inputSchema: {
        jobId: z.string().uuid().optional(),
        projectId: z.string().min(2).max(32).optional(),
        title: z.string().max(120).optional(),
        objective: z.string().max(4_000).optional(),
        context: z.string().max(60_000).optional(),
        executionMode: z.enum(["plan", "workspace_write"]).optional(),
        model: z.string().min(1).max(120).optional(),
        effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/outputTemplate": WIDGET_URI,
      },
    },
    async (args) => safeResult(async () => {
      const selectedJob = args.jobId ? await runtime.store.snapshot(args.jobId, 0) : undefined;
      return result(
        {
          status: await bridgeStatus(runtime),
          selectedJob,
          draft: {
            projectId: args.projectId,
            title: args.title,
            objective: args.objective,
            context: args.context,
            executionMode: args.executionMode,
            model: args.model,
            effort: args.effort,
          },
        },
        args.jobId ? "Opened the selected Codex job." : "Opened the Codex control console.",
      );
    }),
  );

  server.registerTool(
    "codex_job_get",
    {
      title: "Get Codex job",
      description: "Read a Codex job snapshot and bounded events. Use after dispatch to report current progress or approval needs.",
      annotations: readAnnotations(),
      inputSchema: {
        jobId: z.string().uuid(),
        afterSeq: z.number().int().min(0).optional(),
        maxEvents: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => safeResult(async () => {
      const snapshot = await runtime.store.snapshot(args.jobId, args.afterSeq ?? 0, args.maxEvents ?? 80);
      return result(snapshot, describeSnapshot(snapshot));
    }),
  );

  server.registerTool(
    "codex_artifact_get",
    {
      title: "Read Codex job artifact",
      description: "Read a bounded request, final response, diff, or result metadata artifact for an existing Codex job.",
      annotations: readAnnotations(),
      inputSchema: {
        jobId: z.string().uuid(),
        artifact: z.enum(["request", "response", "diff", "result"]),
        maxChars: z.number().int().min(1).max(200_000).optional(),
      },
    },
    async (args) => safeResult(async () => {
      const content = await runtime.store.readArtifact(args.jobId, args.artifact, args.maxChars ?? 100_000);
      return result({ jobId: args.jobId, artifact: args.artifact, content }, `Loaded ${args.artifact} artifact.`);
    }),
  );

  server.registerTool(
    "codex_artifact_list",
    {
      title: "List Codex job artifacts",
      description: "List metadata for the request, final response, and aggregated diff artifacts available for a Codex job.",
      annotations: readAnnotations(),
      inputSchema: { jobId: z.string().uuid() },
    },
    async (args) => safeResult(async () => {
      const artifacts = await runtime.store.listArtifacts(args.jobId);
      return result({ jobId: args.jobId, artifacts }, `Listed ${artifacts.length} artifacts for job ${args.jobId}.`);
    }),
  );

  registerAppTool(
    server,
    "codex_text_bundle_begin",
    {
      title: "Begin staged text artifact",
      description: "Create a bounded server-owned staging slot for one pasted text artifact. Available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: {
        clientTransferId: z.string().uuid(),
        projectId: z.string().min(2).max(32),
        fileName: z.string().min(1).max(120),
        mimeType: z.enum(["text/plain", "text/markdown", "application/json", "application/yaml", "text/yaml", "text/x-diff", "text/x-patch"]),
        dataClassification: z.enum(["personal", "public", "company_approved"]),
        totalChars: z.number().int().min(1).max(500_000),
        totalBytes: z.number().int().min(1).max(2_000_000),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        chunkCount: z.number().int().min(1).max(256),
        companyAuthorizationConfirmed: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      requireAllowedProject(runtime, args.projectId);
      if (args.dataClassification === "company_approved" && args.companyAuthorizationConfirmed !== true) {
        throw new Error("Company-approved data requires an explicit authorization confirmation in the app.");
      }
      const begun = await runtime.textBundles.begin(args);
      return result(
        { bundleId: begun.bundle.id, created: begun.created, status: begun.bundle.status, receivedChunks: begun.bundle.receivedChunks },
        begun.created ? `Prepared staging for ${begun.bundle.fileName}.` : `Reused staging for ${begun.bundle.fileName}.`,
      );
    }),
  );

  registerAppTool(
    server,
    "codex_text_bundle_append",
    {
      title: "Append staged text chunk",
      description: "Append one verified chunk to a server-owned text staging slot. Available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: {
        bundleId: z.string().uuid(),
        index: z.number().int().min(0).max(255),
        content: z.string().min(1).max(20_000),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      const bundle = await runtime.textBundles.append(args.bundleId, args.index, args.content, args.sha256);
      return result(
        { bundleId: bundle.id, status: bundle.status, receivedChunks: bundle.receivedChunks, chunkCount: bundle.chunkCount },
        `Stored chunk ${args.index + 1} of ${bundle.chunkCount} for ${bundle.fileName}.`,
      );
    }),
  );

  registerAppTool(
    server,
    "codex_text_bundle_finalize",
    {
      title: "Finalize staged text artifact",
      description: "Verify all chunks, exact UTF-8 size, and full SHA-256 before a staged text artifact can be attached. Available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: { bundleId: z.string().uuid() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      const bundle = await runtime.textBundles.finalize(args.bundleId);
      return result(
        { bundleId: bundle.id, fileName: bundle.fileName, mimeType: bundle.mimeType, chars: bundle.chars, bytes: bundle.bytes, sha256: bundle.sha256, status: bundle.status },
        `Verified and finalized ${bundle.fileName}.`,
      );
    }),
  );

  registerAppTool(
    server,
    "codex_artifact_read_chunk",
    {
      title: "Load Codex artifact chunk",
      description: "Load one bounded result-artifact chunk into the interactive app without placing its content in model-visible structured content.",
      annotations: readAnnotations(),
      inputSchema: {
        jobId: z.string().uuid(),
        artifact: z.enum(["request", "response", "diff"]),
        cursor: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(1).max(20_000).optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      const chunk = await runtime.store.readArtifactChunk(args.jobId, args.artifact, args.cursor ?? 0, args.maxChars ?? 20_000);
      const { content, ...metadata } = chunk;
      return result(
        { jobId: args.jobId, artifact: metadata },
        `Loaded ${chunk.name} characters ${chunk.cursor}-${chunk.cursor + chunk.content.length}.`,
        { artifactContent: content },
      );
    }),
  );

  registerAppTool(
    server,
    "codex_job_dispatch",
    {
      title: "Dispatch Codex job",
      description: "Start the exact reviewed work package. This action is available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: {
        ...workPackageInput,
        previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
        idempotencyKey: z.string().min(8).max(128),
        companyAuthorizationConfirmed: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      requireAllowedProject(runtime, args.projectId);
      const preview = previewWorkPackage(args);
      if (preview.workPackage.dataClassification === "company_approved" && args.companyAuthorizationConfirmed !== true) {
        throw new Error("Company-approved data requires an explicit authorization confirmation in the app.");
      }
      const dispatched = await runtime.controller.dispatch({
        preview,
        previewDigest: args.previewDigest,
        idempotencyKey: args.idempotencyKey,
      });
      const snapshot = await runtime.store.snapshot(dispatched.record.id, 0);
      return result(
        { job: snapshot, created: dispatched.created },
        dispatched.created ? `Started Codex job ${snapshot.id}.` : `Returned existing job ${snapshot.id}.`,
      );
    }),
  );

  registerAppTool(
    server,
    "codex_conversation_send",
    {
      title: "Send Codex conversation message",
      description:
        "Send a message in an existing Codex conversation. It steers the active turn or resumes the same Codex thread for a new turn. This action is available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: {
        jobId: z.string().uuid(),
        clientMessageId: z.string().min(8).max(128),
        message: z.string().min(1).max(4_000),
        context: z.string().max(60_000).optional(),
        executionMode: z.enum(["plan", "workspace_write"]),
        dataClassification: z.enum(["personal", "public", "company_approved"]),
        model: z.string().min(1).max(120).optional(),
        effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
        inputBundleIds: z.array(z.string().uuid()).max(8).optional(),
        companyAuthorizationConfirmed: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      if (args.dataClassification === "company_approved" && args.companyAuthorizationConfirmed !== true) {
        throw new Error("Company-approved data requires an explicit authorization confirmation in the app.");
      }
      const sent = await runtime.controller.sendMessage({
        jobId: args.jobId,
        clientMessageId: args.clientMessageId,
        content: args.message,
        context: args.context,
        executionMode: args.executionMode,
        dataClassification: args.dataClassification,
        model: args.model,
        effort: args.effort,
        inputBundleIds: args.inputBundleIds,
      });
      const snapshot = await runtime.store.snapshot(sent.record.id, 0);
      return result(
        { job: snapshot, accepted: sent.accepted, delivery: sent.delivery },
        sent.delivery === "steer"
          ? `Sent guidance to active conversation ${snapshot.id}.`
          : sent.delivery === "turn"
            ? `Started a new turn in conversation ${snapshot.id}.`
            : `Returned the existing message for conversation ${snapshot.id}.`,
      );
    }),
  );

  registerAppTool(
    server,
    "codex_job_cancel",
    {
      title: "Cancel Codex job",
      description: "Interrupt a running Codex turn. This action is available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: { jobId: z.string().uuid() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      const job = await runtime.controller.cancel(args.jobId);
      return result({ job: await runtime.store.snapshot(job.id, 0) }, `Cancelled job ${job.id}.`);
    }),
  );

  registerAppTool(
    server,
    "codex_job_steer",
    {
      title: "Steer Codex job",
      description: "Send bounded guidance to a running Codex turn. This action is available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: { jobId: z.string().uuid(), message: z.string().min(1).max(4_000) },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      const job = await runtime.controller.steer(args.jobId, args.message);
      return result({ job: await runtime.store.snapshot(job.id, 0) }, `Sent guidance to job ${job.id}.`);
    }),
  );

  registerAppTool(
    server,
    "codex_approval_decide",
    {
      title: "Decide Codex approval",
      description:
        "Accept, decline, or cancel one exact pending command or file-change request. This action is available only from the interactive app.",
      annotations: actionAnnotations(false),
      inputSchema: {
        jobId: z.string().uuid(),
        approvalId: z.string().uuid(),
        decision: z.enum(["accept", "decline", "cancel"]),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => safeResult(async () => {
      const job = await runtime.controller.decideApproval(args.jobId, args.approvalId, args.decision);
      return result(
        { job: await runtime.store.snapshot(job.id, 0) },
        `${args.decision} recorded for approval ${args.approvalId}.`,
      );
    }),
  );

  return server;
}

async function bridgeStatus(runtime: BridgeRuntime): Promise<BridgeStatus> {
  const recentJobs = runtime.store.list(runtime.config.maxRecentJobs);
  const models = await runtime.controller.listModels().catch(() => []);
  return {
    ok: true,
    service: "codex-handoff-bridge",
    version: "1.1.0",
    buildId: runtime.config.buildId,
    controller: runtime.controller.status,
    projects: Array.from(runtime.config.projects.values()).map(({ id, name }) => ({ id, name })),
    models,
    recentJobs,
    stateVersion: recentJobs.reduce((max, job) => Math.max(max, job.stateVersion), 0),
  };
}

function requireAllowedProject(runtime: BridgeRuntime, projectId: string): void {
  if (!runtime.config.projects.has(projectId)) {
    throw new Error(`Unknown project id '${projectId}'.`);
  }
}

function describeSnapshot(snapshot: JobSnapshot): string {
  const approval = snapshot.pendingApprovalCount === 1 ? " One approval is pending." : snapshot.pendingApprovalCount > 1 ? ` ${snapshot.pendingApprovalCount} approvals are pending.` : "";
  return `Job ${snapshot.id} is ${snapshot.status}.${approval}`;
}

function readAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
}

function actionAnnotations(destructive: boolean) {
  return { readOnlyHint: false, destructiveHint: destructive, openWorldHint: false };
}

function result(value: unknown, message: string, meta?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: value as Record<string, unknown>,
    ...(meta ? { _meta: meta } : {}),
  };
}

async function safeResult(operation: () => Promise<ReturnType<typeof result>>) {
  try {
    return await operation();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    };
  }
}
