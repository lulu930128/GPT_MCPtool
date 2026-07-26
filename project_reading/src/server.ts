import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import {
  getWorkspaceInfo,
  gitStatusSummary,
  listDirectory,
  listProjects,
  readProjectContext,
  readWorkspaceFile,
  searchText,
} from "./workspace.js";

export function createWorkspaceMcpServer(config: ServerConfig): McpServer {
  const rootInput = z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(`Configured root id. Defaults to ${config.defaultRootId}.`);
  const server = new McpServer(
    {
      name: "gpt-project-workspace-mcp",
      version: "0.3.0",
    },
    {
      instructions:
        "Read-only multi-root workspace context server. Select only configured root ids and inspect allowed files. Do not ask this server to write, delete, run shell commands, expose secrets, read denied files, or bypass path limits.",
    },
  );

  server.registerTool(
    "workspace_info",
    {
      title: "Workspace Info",
      description: "Show this server's configured workspace root, read-only mode, limits, and deny policy.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => toTextResult(await getWorkspaceInfo(config)),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description: "List direct child project folders under a configured workspace root.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        root: rootInput,
      },
    },
    async (args) => safeResult(() => listProjects(config, args)),
  );

  server.registerTool(
    "project_context",
    {
      title: "Project Context",
      description:
        "Read bounded entrypoint context for a project, including AGENTS.md, README, package scripts, and common config files.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        root: rootInput,
        project: z.string().optional().describe("Project path relative to the workspace root. Defaults to the root."),
      },
    },
    async (args) => safeResult(() => readProjectContext(config, args)),
  );

  server.registerTool(
    "list_dir",
    {
      title: "List Directory",
      description: "List a directory under the workspace root with conservative depth and entry limits.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        root: rootInput,
        path: z.string().optional().describe("Directory path relative to the workspace root. Defaults to the root."),
        depth: z.number().int().min(0).max(3).optional().describe("Recursive depth, capped at 3. Defaults to 1."),
        maxEntries: z.number().int().min(1).max(config.maxDirEntries).optional().describe("Maximum returned entries."),
      },
    },
    async (args) => safeResult(() => listDirectory(config, args)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description:
        "Read a bounded text file under the workspace root. Secrets, local databases, archives, dependencies, caches, and model weights are denied.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        root: rootInput,
        path: z.string().min(1).describe("File path relative to the workspace root."),
        startLine: z.number().int().min(1).optional().describe("1-based starting line. Defaults to 1."),
        maxLines: z.number().int().min(1).max(config.maxReadLines).optional().describe("Maximum lines to return."),
      },
    },
    async (args) => safeResult(() => readWorkspaceFile(config, args)),
  );

  server.registerTool(
    "search_text",
    {
      title: "Search Text",
      description: "Search text within the workspace root. Uses rg when available and a bounded JavaScript fallback otherwise.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        root: rootInput,
        query: z.string().min(1).describe("Search query."),
        path: z.string().optional().describe("Directory path relative to the workspace root. Defaults to the root."),
        glob: z.string().optional().describe("Optional include glob, for example **/*.ts."),
        maxResults: z.number().int().min(1).max(config.maxSearchResults).optional().describe("Maximum matches to return."),
        caseSensitive: z.boolean().optional().describe("Use case-sensitive search. Defaults to false."),
        fixedString: z.boolean().optional().describe("Treat query as a literal string. Defaults to true."),
      },
    },
    async (args) => safeResult(() => searchText(config, args)),
  );

  server.registerTool(
    "git_status_summary",
    {
      title: "Git Status Summary",
      description: "Run a fixed read-only git status summary for a project under the workspace root.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        root: rootInput,
        project: z.string().optional().describe("Project path relative to the workspace root. Defaults to the root."),
      },
    },
    async (args) => safeResult(() => gitStatusSummary(config, args)),
  );

  return server;
}

async function safeResult(read: () => Promise<unknown>) {
  try {
    return toTextResult(await read());
  } catch (error) {
    return toTextResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function toTextResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}
