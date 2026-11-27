import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import { inspectSqlite } from "../src/sqlite-reader.js";
import { inspectGit } from "../src/git-tools.js";
import { findFiles, readWorkspaceFile, readWorkspaceFiles, searchText } from "../src/workspace.js";
import { resolveWorkspaceWritePath } from "../src/path-guard.js";

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"research-v2-"));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const config = await loadConfig({ WORKSPACE_MCP_ROOTS:"fixture="+dir });
  return {config,dir};
}

test("find_files discovers research paths with scope-relative globs and preserves containment", async t => {
  const { config, dir } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "find-external-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  for (const directory of [".git", ".git/objects", ".git/objects/pack", ".git/objects/ab", "data", "data/nested", "data/node_modules"]) {
    await fs.mkdir(path.join(dir, directory));
  }
  for (const file of [".git/HEAD", ".git/index", "data/production.sqlite", "data/nested/one.sqlite",
    ".git/objects/pack/sample.pack", ".git/objects/ab/cdef", "data/legacy.mdb", "data/nested/file.accdb",
    "data/search.db", "data/log.sqlite3", "data/index.bin", "data/.env", "data/.env.dev", "data/node_modules/hidden.db"]) {
    await fs.writeFile(path.join(dir, file), "fixture");
  }
  await fs.writeFile(path.join(outside, "external.sqlite"), "fixture");
  await fs.symlink(outside, path.join(dir, "data", "linked"), "junction");
  const find = async (scope: string, pattern: string, extensions?: string[]) => {
    const result = await findFiles(config, { path: scope, pattern, extensions }) as { results: string[] };
    return result.results.sort();
  };
  assert.deepEqual(await find(".git", "HEAD"), ["HEAD"]);
  assert.deepEqual(await find(".", ".git/index"), [".git/index"]);
  assert.deepEqual(await find(".git", "*.pack"), ["objects/pack/sample.pack"]);
  assert.deepEqual(await find(".git", "objects/ab/*"), ["objects/ab/cdef"]);
  assert.deepEqual(await find("data", "**/*.sqlite"), ["nested/one.sqlite", "production.sqlite"]);
  assert.deepEqual(await find("data", "*"), ["index.bin", "legacy.mdb", "log.sqlite3", "nested/file.accdb", "nested/one.sqlite", "production.sqlite", "search.db"]);
  assert.deepEqual(await find("data", "**/*", [".DB"]), ["search.db"]);
  await assert.rejects(find("data/linked", "*"), /escapes the configured workspace root/);
});

test("SQLite WAL reader sees committed pages, holds one snapshot across pages and refuses mutations", async t => {
  const {DatabaseSync} = await import("node:sqlite");
  const {config,dir} = await fixture(t);
  const file = path.join(dir,"fixture.sqlite");
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT); CREATE INDEX idx ON t(v); INSERT INTO t(v) VALUES ('a'),('b'),('c')");
    const args = {path:"fixture.sqlite",operation:"query" as const,sql:"WITH s AS (SELECT * FROM t WHERE id >= ?) SELECT * FROM s ORDER BY id",parameters:[1],pageSize:1};
    let page = await inspectSqlite(config,args);
    assert.deepEqual(page.rows,[[1,"a"]]); assert.equal(page.columns!.length,2);
    writer.exec("INSERT INTO t(v) VALUES ('later')");
    const rows: unknown[] = [...page.rows!];
    while (page.cursor) { page = await inspectSqlite(config,{...args,cursor:page.cursor}); rows.push(...page.rows!); }
    assert.deepEqual(rows,[[1,"a"],[2,"b"],[3,"c"]]);
    const digest = async () => Promise.all([file,file+"-wal"].map(async f => createHash("sha256").update(await fs.readFile(f)).digest("hex")));
    const before = await digest();
    for (const operation of ["overview","indexes","schema","explain"] as const) {
      const r = await inspectSqlite(config,{...args,parameters:operation === "explain" ? [1] : [],pageSize:100,operation});
      assert.ok(r.rows!.length);
    }
    for (const sql of ["INSERT INTO t(v) VALUES ('x')","UPDATE t SET v='x'","DELETE FROM t","DROP TABLE t",
      "ATTACH DATABASE 'side.db' AS side","PRAGMA wal_checkpoint(TRUNCATE)","PRAGMA query_only=OFF",
      "SELECT load_extension('fixture')","WITH s AS (SELECT 1) DELETE FROM t"]) {
      await assert.rejects(inspectSqlite(config,{...args,sql,parameters:[]}));
    }
    assert.deepEqual(await digest(),before);
    assert.deepEqual(writer.prepare("SELECT count(*) AS n FROM t").get()?.n,4);
  } finally { writer.close(); }
});

test("an abandoned SQLite cursor releases its WAL snapshot after its advertised idle lease", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const { config, dir } = await fixture(t);
  const writer = new DatabaseSync(path.join(dir, "idle.sqlite"));
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v); INSERT INTO t VALUES (1),(2),(3)");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sessions: import("../src/sqlite-reader.js").SqliteSessions = new Map();
    const args = { path: "idle.sqlite", operation: "query" as const, sql: "SELECT v FROM t", pageSize: 1 };
    const page = await inspectSqlite(config, args, sessions);
    const token = page.cursor!;
    const worker = sessions.get(token)!.worker;
    const stopped = new Promise(resolve => worker.once("exit", resolve));
    writer.exec("INSERT INTO t VALUES (4)");
    const before = writer.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()!;
    assert.ok(Number(before.log) > Number(before.checkpointed));
    t.mock.timers.tick(page.cursorIdleTimeoutMs!);
    await stopped;
    assert.equal(sessions.size, 0);
    await assert.rejects(inspectSqlite(config, { ...args, cursor: token }, sessions), /Unknown SQLite cursor/);
    const after = writer.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()!;
    assert.equal(after.log, after.checkpointed);
  } finally { writer.close(); }
});

test("Git committed blob including historical env is exact and raw pack/index reads preserve bytes",async t=>{
  const {dir,config}=await fixture(t);
  const git=(...args:string[])=>execFileSync("git",["-C",dir,...args],{windowsHide:true});
  git("init","-q"); git("config","user.email","test@example.invalid"); git("config","user.name","Fixture");
  const data=Buffer.from([0,255,10,226,128,166]);
  await fs.writeFile(path.join(dir,".env"),data);
  await fs.writeFile(path.join(dir,"first.txt"),"first\n");
  git("add","--",".env","first.txt"); git("commit","-qm","fixture");
  git("mv","first.txt","new.txt"); git("commit","-qm","rename"); git("tag","v1"); git("gc","--quiet");
  const index=await fs.readFile(path.join(dir,".git","index"));
  const head=git("rev-parse","HEAD").toString().trim();
  const blob=await inspectGit(config,{operation:"show",path:".env",tag:"v1"}) as {base64:string;commit:string};
  const objectId = git("rev-parse","HEAD:.env").toString().trim();
  const packed = await inspectGit(config,{operation:"show",revision:objectId,offset:1,length:3}) as {base64:string;objectId:string;nextOffset:number};
  assert.equal(packed.objectId,objectId); assert.equal(packed.nextOffset,4);
  assert.deepEqual(Buffer.from(packed.base64,"base64"),data.subarray(1,4));
  assert.equal(blob.commit,head); assert.deepEqual(Buffer.from(blob.base64,"base64"),data);
  for(const operation of ["status","log","refs","diff","blame","history"] as const) {
    const result=await inspectGit(config,{operation,path:"new.txt",followRenames:true});
    if(operation==="history") assert.match(JSON.stringify(result),/fixture/);
  }
  const pack=(await fs.readdir(path.join(dir,".git","objects","pack"))).find(f=>f.endsWith(".pack"))!;
  for (const file of [".git/objects/pack/"+pack,".git/index",".git/packed-refs",".git/logs/HEAD"]) {
    const result=await readWorkspaceFile(config,{path:file,format:"binary"}) as {base64:string};
    assert.deepEqual(Buffer.from(result.base64,"base64"),await fs.readFile(path.join(dir,file)));
    await assert.rejects(resolveWorkspaceWritePath(config,file,"fixture"));
  }
  assert.deepEqual(await fs.readFile(path.join(dir,".git","index")),index);
  await assert.rejects(readWorkspaceFile(config,{path:".env"}));
});

test("search sorts before paging, supports exact filtered hits and explicit git paths on both engines",async t=>{
  const {dir,config}=await fixture(t);
  for (const name of ["locales","src",".git"]) await fs.mkdir(path.join(dir,name));
  await fs.writeFile(path.join(dir,"locales","a.ts"),"needle\n".repeat(150));
  await fs.writeFile(path.join(dir,"src","z.ts"),"needle\n");
  await fs.writeFile(path.join(dir,".git","config"),"needle\n");
  for(const active of ["ripgrep","javascript"] as const) {
    const cfg={...config,searchRuntime:{...config.searchRuntime,active}};
    const find=async(args:Parameters<typeof searchText>[1])=>await searchText(cfg,args) as {results:{path:string;line:number}[];nextCursor:string};
    const args={query:"needle",maxResults:1};
    const first=await find(args); assert.equal(first.results[0].path,"src/z.ts");
    const next=await find({...args,cursor:first.nextCursor}); assert.equal(next.results[0].path,"locales/a.ts");
    assert.equal((await find({...args,fileKinds:["git"],includeGitInternals:true})).results[0].path,".git/config");
    assert.equal((await find({...args,path:".git"})).results[0].path,".git/config");
    assert.equal((await find({...args,includeGlobs:["**/*.ts"],excludeGlobs:["src/**"]})).results[0].path,"locales/a.ts");
  }
});

test("batch accepts more than twelve files and more than 2400 rows",async t=>{
  const {dir,config}=await fixture(t);
  await fs.writeFile(path.join(dir,"rows.txt"),"文\r\n".repeat(300));
  const files = Array.from({length:20},()=>({path:"rows.txt",maxLines:20000}));
  const batch = await readWorkspaceFiles(config,{files}) as {count:number;totalReturnedLines:number;nextFileIndex:number|null};
  assert.deepEqual([batch.count,batch.totalReturnedLines,batch.nextFileIndex],[20,6000,null]);
});

test("WAL mode with absent auxiliary files can be read raw without creating auxiliaries",async t=>{
  const {DatabaseSync}=await import("node:sqlite");
  const {dir,config}=await fixture(t);
  const writer=new DatabaseSync(path.join(dir,"closed.db"));
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id)");
  writer.close();
  const before=await fs.readdir(dir);
  await assert.rejects(inspectSqlite(config,{path:"closed.db",operation:"overview"}),/WAL_SIDECAR_UNAVAILABLE/);
  await readWorkspaceFile(config,{path:"closed.db",format:"binary"});
  assert.deepEqual(await fs.readdir(dir),before);
});

test("binary ranges bind a source identity and preserve invalid UTF8",async t=>{
  const {dir,config}=await fixture(t);
  await fs.writeFile(path.join(dir,"test.mdb"),Buffer.from([0xff,0,1,2]));
  const first=await readWorkspaceFile(config,{path:"test.mdb",format:"binary",length:2}) as {base64:string;snapshotId:string;nextOffset:number};
  assert.equal(first.nextOffset,2);assert.deepEqual(Buffer.from(first.base64,"base64"),Buffer.from([255,0]));
  await fs.appendFile(path.join(dir,"test.mdb"),"!");
  await assert.rejects(readWorkspaceFile(config,{path:"test.mdb",offset:2,snapshotId:first.snapshotId}),/SOURCE_CHANGED/);
  await assert.rejects(resolveWorkspaceWritePath(config,"test.mdb","fixture"));
});
