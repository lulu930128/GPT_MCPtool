import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { ServerConfig, WorkspaceRootConfig } from "./config.js";
import {
  WorkspaceAccessError,
  getDenialReason,
  isWithinRoot,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  toWorkspaceRelative,
} from "./path-guard.js";
import { runBoundedProcess } from "./process-runner.js";
import { assertTextSource, collectLineWindows, truncateUtf8 } from "./text-reader.js";

export interface SearchTextArgs {
  root?: string;
  query: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  caseSensitive?: boolean;
  fixedString?: boolean;
  beforeLines?: number;
  afterLines?: number;
}

interface SearchMatch {
  path: string;
  absolute: string;
  line: number;
  matchText: string;
}

interface SearchCollection {
  engine: "ripgrep" | "javascript";
  matches: SearchMatch[];
  skipped: number;
  truncated: boolean;
  limitReason?: "results" | "timeout" | "visited_entries" | "output";
  fallbackReason?: string;
}

interface SearchOptions {
  query: string;
  glob?: string;
  globMatches: (relative: string) => boolean;
  maxResults: number;
  caseSensitive: boolean;
  fixedString: boolean;
  beforeLines: number;
  afterLines: number;
}

export async function searchWorkspaceText(
  config: ServerConfig,
  args: SearchTextArgs,
): Promise<unknown> {
  const query = args.query.trim();
  if (!query) {
    throw new WorkspaceAccessError("Search query must not be empty.");
  }
  const scope = await resolveWorkspacePath(config, args.path, "directory", args.root);
  const workspaceRoot = resolveWorkspaceRoot(config, scope.rootId);
  const glob = normalizeGlob(args.glob);
  const options: SearchOptions = {
    query,
    glob,
    globMatches: compileGlobMatcher(glob),
    maxResults: clampInt(args.maxResults ?? config.maxSearchResults, 1, config.maxSearchResults),
    caseSensitive: args.caseSensitive === true,
    fixedString: args.fixedString !== false,
    beforeLines: clampInt(args.beforeLines ?? 0, 0, 20),
    afterLines: clampInt(args.afterLines ?? 0, 0, 20),
  };
  if (!options.fixedString) {
    try {
      new RegExp(query, options.caseSensitive ? "" : "i");
    } catch (error) {
      throw new WorkspaceAccessError(
        `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let collection: SearchCollection;
  if (config.searchRuntime.active === "ripgrep" && config.searchRuntime.command) {
    try {
      collection = await searchWithRipgrep(
        config,
        workspaceRoot,
        scope.absolute,
        config.searchRuntime.command,
        options,
      );
    } catch (error) {
      collection = await searchWithJavaScript(config, workspaceRoot, scope.absolute, options);
      collection.fallbackReason =
        error instanceof Error ? `ripgrep unavailable: ${error.message}` : "ripgrep unavailable";
    }
  } else {
    collection = await searchWithJavaScript(config, workspaceRoot, scope.absolute, options);
  }

  const bounded = await addContext(config, collection.matches, options);
  return {
    engine: collection.engine,
    preferredEngine: config.searchRuntime.preferred,
    fallbackReason: collection.fallbackReason,
    root: workspaceRoot.id,
    query,
    path: toWorkspaceRelative(workspaceRoot.path, scope.absolute),
    beforeLines: options.beforeLines,
    afterLines: options.afterLines,
    count: bounded.results.length,
    skipped: collection.skipped,
    truncated: collection.truncated || bounded.truncated,
    limitReason: bounded.limitReason ?? collection.limitReason,
    results: bounded.results,
  };
}

async function searchWithRipgrep(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  scope: string,
  command: string,
  options: SearchOptions,
): Promise<SearchCollection> {
  const args = [
    "--json",
    "--line-number",
    "--max-columns",
    "240",
    "--max-filesize",
    `${Math.ceil(config.maxFileBytes / 1024)}K`,
    "--glob",
    "!**/.env*",
    "--glob",
    "!**/credentials.json",
    "--glob",
    "!**/token.json",
    "--glob",
    "!**/id_rsa",
    "--glob",
    "!**/id_dsa",
    "--glob",
    "!**/id_ecdsa",
    "--glob",
    "!**/id_ed25519",
  ];
  for (const directory of workspaceRoot.denyDirs) {
    args.push("--glob", `!**/${escapeRgGlob(directory)}/**`);
  }
  for (const extension of config.denyExtensions) {
    args.push("--glob", `!**/*${extension}`);
  }
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.fixedString) args.push("--fixed-strings");
  if (options.glob) args.push("--glob", options.glob);
  args.push(options.query, scope);

  const rawMatches: Array<Omit<SearchMatch, "absolute"> & { absolute: string }> = [];
  let stoppedForResults = false;
  const result = await runBoundedProcess(command, args, {
    timeoutMs: config.searchTimeoutMs,
    maxStdoutBytes: 4_194_304,
    maxStderrBytes: 131_072,
    onStdoutLine: (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (event.type !== "match" || !event.data?.path?.text || !event.data.line_number) {
          return;
        }
        const absolute = path.resolve(event.data.path.text);
        if (
          !isWithinRoot(workspaceRoot.path, absolute) ||
          getDenialReason(config, workspaceRoot, absolute)
        ) {
          return;
        }
        rawMatches.push({
          path: toWorkspaceRelative(workspaceRoot.path, absolute),
          absolute,
          line: event.data.line_number,
          matchText: truncateUtf8((event.data.lines?.text ?? "").trimEnd(), 500).text,
        });
        if (rawMatches.length >= options.maxResults) {
          stoppedForResults = true;
          return "stop";
        }
      } catch {
        // Ignore malformed JSON events but keep the bounded process running.
      }
    },
  });
  if (result.terminationReason === "timeout") {
    return {
      engine: "ripgrep",
      matches: await validateMatches(config, workspaceRoot, rawMatches),
      skipped: 0,
      truncated: true,
      limitReason: "timeout",
    };
  }
  if (result.terminationReason === "output_limit") {
    throw new WorkspaceAccessError("ripgrep exceeded its bounded output limit.");
  }
  if (result.code !== 0 && result.code !== 1 && !stoppedForResults) {
    throw new WorkspaceAccessError(result.stderr.trim() || `ripgrep exited with ${result.code}`);
  }
  return {
    engine: "ripgrep",
    matches: await validateMatches(config, workspaceRoot, rawMatches),
    skipped: 0,
    truncated: stoppedForResults,
    limitReason: stoppedForResults ? "results" : undefined,
  };
}

async function validateMatches(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  matches: SearchMatch[],
): Promise<SearchMatch[]> {
  const validated: SearchMatch[] = [];
  for (const match of matches) {
    try {
      const resolved = await resolveWorkspacePath(config, match.path, "file", workspaceRoot.id);
      validated.push({ ...match, absolute: resolved.absolute, path: resolved.relative });
    } catch {
      // A race or symlink change after rg discovery fails closed for this result.
    }
  }
  return validated;
}

async function searchWithJavaScript(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  scope: string,
  options: SearchOptions,
): Promise<SearchCollection> {
  const matches: SearchMatch[] = [];
  const deadline = Date.now() + config.searchTimeoutMs;
  const matcher = options.fixedString
    ? undefined
    : new RegExp(options.query, options.caseSensitive ? "" : "i");
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  let skipped = 0;
  let visited = 0;
  let limitReason: SearchCollection["limitReason"];

  async function visit(current: string): Promise<void> {
    if (limitReason) return;
    if (Date.now() > deadline) {
      limitReason = "timeout";
      return;
    }
    let children;
    try {
      children = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      skipped += 1;
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    for (const child of children) {
      if (limitReason) return;
      visited += 1;
      if (visited > config.maxSearchVisitedEntries) {
        limitReason = "visited_entries";
        return;
      }
      if (Date.now() > deadline) {
        limitReason = "timeout";
        return;
      }
      const absolute = path.join(current, child.name);
      if (getDenialReason(config, workspaceRoot, absolute)) {
        skipped += 1;
        continue;
      }
      if (child.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (child.isDirectory()) {
        const real = await fsp.realpath(absolute).catch(() => undefined);
        if (!real || !isWithinRoot(workspaceRoot.path, real)) {
          skipped += 1;
          continue;
        }
        await visit(real);
        continue;
      }
      if (!child.isFile()) {
        skipped += 1;
        continue;
      }
      const relativeToScope = normalizeRelative(path.relative(scope, absolute));
      if (!options.globMatches(relativeToScope)) {
        continue;
      }
      const stat = await fsp.stat(absolute).catch(() => undefined);
      if (!stat || stat.size > config.maxFileBytes) {
        skipped += 1;
        continue;
      }
      try {
        await assertTextSource(absolute, stat.size, config.maxFileBytes);
      } catch {
        skipped += 1;
        continue;
      }

      const input = fs.createReadStream(absolute, { encoding: "utf8" });
      const reader = readline.createInterface({ input, crlfDelay: Infinity });
      let lineNumber = 0;
      try {
        for await (const line of reader) {
          lineNumber += 1;
          if (Date.now() > deadline) {
            limitReason = "timeout";
            break;
          }
          const haystack = options.caseSensitive ? line : line.toLowerCase();
          const matched = options.fixedString ? haystack.includes(needle) : matcher?.test(line) === true;
          if (!matched) continue;
          matches.push({
            path: toWorkspaceRelative(workspaceRoot.path, absolute),
            absolute,
            line: lineNumber,
            matchText: truncateUtf8(line, 500).text,
          });
          if (matches.length >= options.maxResults) {
            limitReason = "results";
            break;
          }
        }
      } finally {
        reader.close();
        input.destroy();
      }
    }
  }

  await visit(scope);
  return {
    engine: "javascript",
    matches,
    skipped,
    truncated: Boolean(limitReason),
    limitReason,
  };
}

async function addContext(
  config: ServerConfig,
  matches: SearchMatch[],
  options: SearchOptions,
): Promise<{
  results: unknown[];
  truncated: boolean;
  limitReason?: "timeout" | "output";
}> {
  const grouped = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const values = grouped.get(match.absolute) ?? [];
    values.push(match);
    grouped.set(match.absolute, values);
  }
  const contexts = new Map<number, { startLine: number; endLine: number; text: string }>();
  const collectedIds = new Set<number>();
  const deadline = Date.now() + config.searchTimeoutMs;
  let timedOut = false;
  let matchId = 0;
  const ids = new Map<SearchMatch, number>();
  for (const [absolute, fileMatches] of grouped) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const stat = await fsp.stat(absolute);
    const windows = fileMatches.map((match) => {
      const id = matchId++;
      ids.set(match, id);
      return {
        id,
        startLine: Math.max(1, match.line - options.beforeLines),
        endLine: match.line + options.afterLines,
      };
    });
    const collected = await collectLineWindows(absolute, stat.size, windows, config.maxFileBytes);
    for (const window of collected) {
      contexts.set(window.id, window);
      collectedIds.add(window.id);
    }
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
  }

  const results: unknown[] = [];
  let returnedBytes = 0;
  let truncated = false;
  for (const match of matches) {
    const id = ids.get(match) ?? -1;
    if (!collectedIds.has(id)) {
      truncated = true;
      break;
    }
    const context = contexts.get(id)!;
    const overhead = Buffer.byteLength(match.path, "utf8") + Buffer.byteLength(match.matchText, "utf8") + 64;
    const remaining = config.maxSearchReturnedBytes - returnedBytes - overhead;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const boundedText = truncateUtf8(context.text, remaining);
    results.push({
      path: match.path,
      line: match.line,
      startLine: context.startLine,
      endLine: context.endLine,
      matchText: match.matchText,
      text: boundedText.text,
      truncated: boundedText.truncated,
    });
    returnedBytes += overhead + boundedText.bytes;
    if (boundedText.truncated) {
      truncated = true;
      break;
    }
  }
  return {
    results,
    truncated: truncated || timedOut,
    limitReason: timedOut ? "timeout" : truncated ? "output" : undefined,
  };
}

export function compileGlobMatcher(pattern: string | undefined): (relative: string) => boolean {
  const normalized = normalizeGlob(pattern);
  if (!normalized) return () => true;
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  expression += "$";
  const regex = new RegExp(expression, "i");
  const basenameOnly = !normalized.includes("/");
  return (relative) => regex.test(basenameOnly ? path.posix.basename(normalizeRelative(relative)) : normalizeRelative(relative));
}

function normalizeGlob(value: string | undefined): string | undefined {
  const glob = value?.trim();
  if (!glob) return undefined;
  if (
    glob.length > 256 ||
    glob.includes("\0") ||
    glob.startsWith("!") ||
    path.isAbsolute(glob) ||
    path.win32.isAbsolute(glob) ||
    /^[a-z]:/i.test(glob) ||
    normalizeRelative(glob).split("/").includes("..")
  ) {
    throw new WorkspaceAccessError("Search glob must be a bounded relative include pattern.");
  }
  return normalizeRelative(glob);
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRgGlob(value: string): string {
  return value.replace(/([\\*?[\]{}])/g, "\\$1");
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
