// Run after an isolated build. Each run owns its fixtures and transfer scratch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/src/config.js";
import { createWorkspaceMcpServer } from "../dist/src/server.js";
import { segmentedTransfers } from "../dist/src/segmented-transfer.js";
const dir = await fs.mkdtemp(path.join(os.tmpdir(),"workspace-v2-scale-"));
const scratch = path.join(dir,"scratch");
const root = path.join(dir,"input");
await Promise.all([fs.mkdir(scratch),fs.mkdir(root)]);
process.env.TMP = process.env.TEMP = process.env.TMPDIR = scratch;
const config = await loadConfig({WORKSPACE_MCP_ROOTS:"fixture="+root});
const server = createWorkspaceMcpServer(config);
const client = new Client({name:"isolated-scale",version:"2"});
const [a,b] = InMemoryTransport.createLinkedPair();
await server.connect(b); await client.connect(a);
await client.listTools(); // Enable client-side validation of the advertised output contracts.
let largestMessage = 0;
const size = 2 ** 30;
function measure(result) {
  const bytes = Buffer.byteLength(JSON.stringify({jsonrpc:"2.0",id:999999,result}));
  assert.ok(bytes <= 10 * 1024 * 1024);
  largestMessage = Math.max(largestMessage,bytes);
}
async function call(name,args) {
  const r = await client.callTool({name,arguments:args}); measure(r);
  assert.ok(!r.isError,JSON.stringify(r.content).slice(0,500));
  return r.structuredContent;
}
try {
  const expected = {};
  for (const [name,unit] of [["unicode.txt",Buffer.from("字😀\r\n")],["bytes.bin",Buffer.from([0,255,92,33,7])]]) {
    const file = await fs.open(path.join(root,name),"wx");
    const h = createHash("sha256");
    const chunk = Buffer.alloc(unit.length * 100000,unit);
    try {
      for (let done = 0; done < size;) {
        const slice = chunk.subarray(0,Math.min(size-done,chunk.length));
        if (name === "unicode.txt" && done + slice.length === size) slice.fill(65,Math.floor(slice.length/unit.length)*unit.length);
        await file.writeFile(slice); h.update(slice); done += slice.length;
      }
    } finally { await file.close(); }
    expected[name]=h.digest("hex");
  }
  const text = await call("read_file",{path:"unicode.txt",format:"text",maxLines:20000});
  assert.equal(text.returnedLines,20000);
  const resumed = await call("read_file",{path:"unicode.txt",maxLines:20000,startLine:text.nextStartLine,offset:text.nextOffset,snapshotId:text.snapshotId});
  assert.equal(resumed.returnedLines,20000);
  assert.ok(resumed.metrics.scannedBytes < 2**20);
  const begin = performance.now();
  const batch = await call("read_files",{files:Object.keys(expected).map(path=>({path,maxLines:20000,delivery:"resource"}))});
  for (const row of batch.files) {
    const taskId = row.transfer.taskId;
    let state;
    do {
      await new Promise(resolve=>setTimeout(resolve,100));
      state = await call("get_segmented_transfer",{taskId});
    } while (state.state === "running");
    assert.equal(state.state,"ready",state.error);
    const h = createHash("sha256"); let total=0, offset=0;
    do {
      const page = await call("list_segmented_transfer",{taskId,offset});
      for (const part of page.records) {
        const resource = await client.readResource({uri:part.resourceUri}); measure(resource);
        const bytes = Buffer.from(resource.contents[0].blob,"base64");
        assert.equal(createHash("sha256").update(bytes).digest("hex"),part.sha256);
        assert.equal(part.offset,total);
        total += bytes.length; h.update(bytes);
      }
      offset = page.nextOffset;
    } while (offset !== null);
    const hash = h.digest("hex");
    assert.equal(total,size); assert.equal(hash,expected[row.path]); assert.equal(hash,state.archiveSha256);
    await call("finish_segmented_transfer",{taskId,action:"complete",archiveSha256:hash});
    console.log(JSON.stringify({path:row.path,total,hash,parts:state.chunkCount}));
  }
  console.log(JSON.stringify({batchElapsedMs:Math.round(performance.now()-begin),largestMessage,peakRSSKiB:process.resourceUsage().maxRSS,
    resumeScannedBytes:resumed.metrics.scannedBytes,firstPageScanMs:text.metrics.serverExecMs}));
} finally {
  await client.close(); await server.close(); await segmentedTransfers().close();
  await fs.rm(dir,{recursive:true,force:true});
}
