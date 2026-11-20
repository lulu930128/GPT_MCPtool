import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { resolveResearchPath } from "./path-guard.js";
import type { ServerConfig } from "./config.js";

const scalar = z.union([z.string(), z.number(), z.null()]);
export const sqliteInput = {
  root: z.string().optional(), path: z.string(), operation: z.enum(["overview","schema","indexes","query","explain"]).default("overview"),
  sql: z.string().optional(), parameters: z.union([z.array(scalar), z.record(scalar)]).optional(),
  pageSize: z.number().int().positive().optional(), cursor: z.string().uuid().optional(), close: z.boolean().optional(),
};
type Args = z.infer<z.ZodObject<typeof sqliteInput>>;
type Session = { worker: ChildProcess; path: string; root: string; busy: boolean };
export type SqliteSessions = Map<string, Session>;
const directSessions: SqliteSessions = new Map();

async function stopReader(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill();
  await closed;
}

export async function inspectSqlite(config: ServerConfig, args: Args, sessions = directSessions) {
  const resolved = await resolveResearchPath(config, args.path, "file", args.root);
  if (!args.cursor) {
    // A read-only SQLite WAL open may create missing auxiliary files. Inspect the
    // database header before invoking SQLite, while preserving normal live locking.
    const file = await fs.open(resolved.absolute,"r");
    const header = Buffer.alloc(20);
    try { await file.read(header,0,header.length,0); } finally { await file.close(); }
    if (header.subarray(0,16).toString() === "SQLite format 3\0" && (header[18] === 2 || header[19] === 2)) {
      for (const suffix of ["-wal","-shm"]) {
        try { await resolveResearchPath(config, resolved.relative+suffix, "file", resolved.rootId); }
        catch { throw new Error("WAL_SIDECAR_UNAVAILABLE: SQLite may create missing sidecars. Use read_file for raw bytes."); }
      }
    }
  }
  if (args.close && !args.cursor) throw new Error("Closing a SQLite reader requires its cursor.");
  const token = args.cursor ?? randomUUID();
  const session = args.cursor ? sessions.get(token) : {
    worker: fork(new URL(import.meta.url), ["--sqlite-reader"], {
      execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
    }),
    path: resolved.absolute, root: resolved.rootId, busy: false,
  };
  if (!session || session.path !== resolved.absolute || session.root !== resolved.rootId) throw new Error("Unknown SQLite cursor.");
  if (session.busy) throw new Error("SQLite cursor has a page in flight.");
  if (args.close) { sessions.delete(token); await stopReader(session.worker); return { closed: true, cursor: null, rows: [], columns: [], eof: true }; }
  session.busy = true;
  sessions.set(token, session);
  const begin = performance.now();
  const worker = session.worker;
  try {
    const page = await new Promise<{ rows: unknown[]; columns: unknown[]; eof: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("SQLite request reached tunnel deadline.")), 119_000);
      function done(error?: Error, page?: any) {
        clearTimeout(timer); worker.off("message", message); worker.off("error", done); worker.off("exit", exit);
        if (error) reject(error); else resolve(page);
      }
      function exit() { done(new Error("SQLite reader closed.")); }
      function message(page: any) { done(page.error ? new Error(page.error) : undefined, page); }
      worker.once("message", message); worker.once("error", done); worker.once("exit", exit);
      const request = args.cursor ? args.pageSize ?? 1000 :
        { file: resolved.absolute, args, pageSize: args.pageSize ?? 1000 };
      worker.send(request, error => { if (error) done(error); });
    });
    if (page.eof) sessions.delete(token);
    else { worker.unref(); if (!args.cursor) worker.once("exit", () => sessions.delete(token)); }
    return { ...page, cursor: page.eof ? null : token, latencyMs: performance.now() - begin, consistency: "sqlite_statement_snapshot" };
  } catch (error) { sessions.delete(token); await stopReader(worker); throw error; }
  finally { session.busy = false; }
}

async function serveStatement(request: {file: string; args: Args; pageSize: number}) {
  try {
    const { DatabaseSync, constants: c } = await import("node:sqlite");
    const db = new DatabaseSync(request.file, { readOnly: true, allowExtension: false });
    if (typeof db.setAuthorizer !== "function") throw new Error("inspect_sqlite requires a Node SQLite runtime with setAuthorizer (Node 24.10 or later).");
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const readActions = new Set([c.SQLITE_READ, c.SQLITE_SELECT, c.SQLITE_FUNCTION, c.SQLITE_RECURSIVE]);
    // Only side-effect-free PRAGMA operations may be prepared. SQLite invokes
    // the authorizer for statements inside CTEs, views and EXPLAIN as well.
    const introspection = new Set(["table_info","table_xinfo","table_list","index_list","index_info","index_xinfo",
      "foreign_key_list","foreign_key_check","integrity_check","quick_check"]);
    db.setAuthorizer((action, name, argument) => {
      if (action === c.SQLITE_PRAGMA) {
        const pragma = (name ?? "").toLowerCase();
        if (introspection.has(pragma)) return c.SQLITE_OK;
        if (argument === null && !["optimize","incremental_vacuum","wal_checkpoint","shrink_memory"].includes(pragma)) return c.SQLITE_OK;
      }
      return readActions.has(action) ? c.SQLITE_OK : c.SQLITE_DENY;
    });
    const args = request.args;
    const catalog = "SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema";
    const sql = args.operation === "overview" ? "SELECT type,count(*) AS count FROM sqlite_schema GROUP BY type" :
      args.operation === "schema" ? catalog + " ORDER BY type,name" : args.operation === "indexes" ? catalog + " WHERE type='index' ORDER BY name" :
      (args.operation === "explain" ? "EXPLAIN QUERY PLAN " : "") + (args.sql ?? "");
    const stmt = db.prepare(sql);
    if (sql.slice(stmt.sourceSQL.length).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,"").trim()) throw new Error("Expected one SQL statement.");
    stmt.setReadBigInts(true); stmt.setReturnArrays(true);
    const params = args.parameters;
    const iterator = Array.isArray(params) ? stmt.iterate(...params) : params ? stmt.iterate(params) : stmt.iterate();
    const columns = stmt.columns();
    let item = iterator.next();
    function readPage(pageSize: number) {
      try {
        const rows: unknown[] = [];
        let used = Buffer.byteLength(JSON.stringify(columns));
        while (!item.done && rows.length < pageSize) {
          const row = (item.value as unknown as unknown[]).map(v => typeof v === "bigint" ?
            (Number.isSafeInteger(Number(v)) ? Number(v) : { integer: String(v) }) : v instanceof Uint8Array ? { base64: Buffer.from(v).toString("base64") } : v);
          const cost = Buffer.byteLength(JSON.stringify(row)) + 1;
          if (used + cost > 10 * 1024 * 1024 - 65536) {
            if (!rows.length) throw new Error("Single SQL row exceeds tunnel message size. Select a column range with substr().");
            break;
          }
          rows.push(row); used += cost; item = iterator.next();
        }
        if (item.done) db.close();
        process.send!({ rows, columns, eof: !!item.done }, () => {
          if (item.done && process.connected) process.disconnect();
        });
      } catch (error) { finishError(error); }
    }
    process.on("message", pageSize => readPage(Number(pageSize)));
    readPage(request.pageSize);
  } catch (error) { finishError(error); }
}

function finishError(error: unknown) {
  process.send!({ error: String(error) }, () => { if (process.connected) process.disconnect(); });
}

if (process.argv[2] === "--sqlite-reader" && process.send) {
  process.once("disconnect", () => process.exit());
  process.once("message", request => void serveStatement(request as Parameters<typeof serveStatement>[0]));
}
