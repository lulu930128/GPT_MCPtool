import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server-client.js";

test("App Server version comes from each initialize handshake and clears on close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-handshake-test-"));
  const script = join(root, "server.mjs");
  const agentFile = join(root, "agent.txt");
  await writeFile(script, `import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id) console.log(JSON.stringify({ id: message.id, result: message.method === "initialize"
    ? { userAgent: readFileSync(process.argv[2], "utf8"), codexHome: "private-home" } : {} }));
});`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [script, agentFile], requestTimeoutMs: 5000 });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(client.protocolVersion, null);
  for (const [agent, expected] of [
    ["codex-handoff-bridge/0.165.0 (Windows; private-host) unknown", "0.165.0"],
    ["codex-handoff-bridge/1.0.0 (Windows)", "1.0.0"],
    ["unrecognized/private-host", null],
    ["codex-handoff-bridge/0.165.0/private-host", null],
  ] as const) {
    await writeFile(agentFile, agent);
    await client.ensureStarted();
    assert.equal(client.status, "ready");
    assert.equal(client.protocolVersion, expected);
    client.setNotificationBacklog(1024*1024);
    await client.request("fixture/read"); // A pending reply must resume shared stdout.
    client.setNotificationBacklog(1024*1024);
    await client.close();
    assert.equal(client.protocolVersion, null);
  }
});

test("a timed-out mutation keeps its original RPC correlation until the late reply and drains final stdout", async t => {
  const root=await mkdtemp(join(tmpdir(),"bridge-late-"));
  const script=join(root,"peer.mjs");
  await writeFile(script,`import {createInterface} from "node:readline";
    let original;
    createInterface({input:process.stdin}).on("line",line=>{
      const msg=JSON.parse(line);
      if(msg.method==="initialize") console.log(JSON.stringify({id:msg.id,result:{userAgent:"codex-handoff-bridge/0.172.0"}}));
      if(msg.method==="turn/start") original=msg.id;
      if(msg.method==="fixture/release"){
        console.log(JSON.stringify({id:msg.id,result:{}}));
        console.log(JSON.stringify({id:original,result:{turn:{id:"original"}}}));
        console.log(JSON.stringify({method:"turn/completed",params:{turnId:"original"}}));
        process.stdin.destroy();
      }
    });`);
  const client=new CodexAppServerClient({command:process.execPath,args:[script],requestTimeoutMs:1500});
  t.after(async()=>{await client.close();await rm(root,{recursive:true,force:true});});
  await client.ensureStarted();
  const order:string[]=[];
  client.on("notification",n=>order.push(n.method));
  const closed=new Promise<void>(resolve=>client.once("exit",()=>{order.push("close");resolve();}));
  await assert.rejects(client.request("turn/start",{},(result,rejected)=>{
    assert.equal(rejected,false); assert.deepEqual(result,{turn:{id:"original"}}); order.push("late");
  }),/timed out/);
  await client.request("fixture/release",{});
  await closed;
  assert.deepEqual(order,["late","turn/completed","close"]);
});
