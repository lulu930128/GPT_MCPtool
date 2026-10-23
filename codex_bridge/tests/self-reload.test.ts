import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createHash, sign, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SelfReloadClient, ReloadError, RELOAD_CONTRACT, type ReloadReply } from "../src/self-reload/client.js";
import { JobStore } from "../src/job-store.js";
import { healthPayload, startBridgeHttpServer } from "../src/http-server.js";
import { createCodexBridgeMcpServer } from "../src/server.js";
import { RemotePrivilegedBroker } from "../src/privileged/broker.js";
import type { BridgeRuntime } from "../src/runtime.js";
import { previewWorkPackage } from "../src/work-package.js";

const keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const jwk=keys.publicKey.export({format:"jwk"});
const policy={rpId:"reload.example.test",origin:"https://reload.example.test",topOrigin:"https://chatgpt.com",credentialId:Buffer.from("synthetic-credential").toString("base64url"),x:jwk.x,y:jwk.y};
const baseSnapshot=()=>({oldPid:8101,oldBuildId:"1111111111111111",targetBuildId:"2222222222222222",active:1,awaitingApproval:0,
  controller:"ready",scope:"all",drainRequestId:"",drainExpiresAt:"",ownerVerified:true});
function assertion(digest:string, overrides:Record<string,unknown>={}, flags=5, signer=keys.privateKey) {
  const clientData=Buffer.from(JSON.stringify({type:"webauthn.get",challenge:Buffer.from(digest).toString("base64url"),origin:policy.origin,crossOrigin:true,topOrigin:policy.topOrigin,...overrides}));
  const auth=Buffer.concat([createHash("sha256").update(policy.rpId).digest(),Buffer.from([flags]),Buffer.alloc(4)]);
  const signature=sign("sha256",Buffer.concat([auth,createHash("sha256").update(clientData).digest()]),signer);
  return {credentialId:policy.credentialId,clientDataJSON:clientData.toString("base64url"),authenticatorData:auth.toString("base64url"),signature:signature.toString("base64url")};
}

async function ownerFixture(t: any, root?:string) {
  const dir=root??await mkdtemp(join(tmpdir(),"r1-owner-"));
  if (!root) t.after(()=>rm(dir,{recursive:true,force:true}));
  const child=spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",resolve("../mcp_control_center/tests/self-reload-fixture.ps1"),"-Root",dir],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let stderr="";child.stderr.on("data",c=>stderr+=c);
  const lines=createInterface({input:child.stdout});
  const waiting:Array<{resolve:(r:ReloadReply)=>void,reject:(e:Error)=>void}>=[];
  lines.on("line",line=>{const item=waiting.shift();try{const data=JSON.parse(line);if(!data.ok)item?.reject(new ReloadError(data.code));else item?.resolve(data.result);}catch{item?.reject(new Error("Bad fixture response: "+line));}});
  child.on("exit",code=>{for(const item of waiting.splice(0))item.reject(new Error(`fixture exited ${code}: ${stderr}`));});
  t.after(()=>{child.stdin.end();child.kill();lines.close();});
  const call=(operation:string,args:Record<string,unknown>={})=>new Promise<ReloadReply>((resolve,reject)=>{waiting.push({resolve,reject});child.stdin.write(JSON.stringify({contract:RELOAD_CONTRACT,operation,arguments:args})+"\n");});
  await call("__init",{policy,snapshot:baseSnapshot()});
  return {call,root:dir,child};
}
async function request(owner:Awaited<ReturnType<typeof ownerFixture>>) {
  const preview=await owner.call("preview");
  const args={idempotencyKey:randomUUID(),previewDigest:preview.previewDigest,ttlSeconds:900};
  return {receipt:await owner.call("request",args),args};
}
const rejected=(operation:Promise<unknown>,code:string)=>assert.rejects(operation,(error:any)=>error.code===code);

test("R1 durable owner: exact signature, idle wait, one dispatch, receipt across Bridge and owner restart",async t=>{
  const owner=await ownerFixture(t);const {receipt:r,args}=await request(owner);
  assert.equal(r.state,"accepted");assert.deepEqual(await owner.call("request",args),r);
  await rejected(owner.call("request",{...args,ttlSeconds:60}),"IDEMPOTENCY_CONFLICT");
  await rejected(owner.call("request",{...args,idempotencyKey:randomUUID()}),"REQUEST_BUSY");
  await rejected(owner.call("approve",{requestId:r.requestId,digest:r.digest,human:true,source:"app"}),"INVALID_MESSAGE");
  await rejected(owner.call("approve",{requestId:r.requestId,digest:"f".repeat(64),assertion:assertion(r.digest)}),"DIGEST_MISMATCH");
  for(const invalid of [assertion(r.digest,{origin:"https://evil.example"}),assertion(r.digest,{topOrigin:"https://evil.example"}),
    assertion(r.digest,{challenge:"forged"}),assertion(r.digest,{},1),assertion(r.digest,{},5,generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey)]) {
    await assert.rejects(owner.call("approve",{requestId:r.requestId,digest:r.digest,assertion:invalid}));
  }
  const approved=await owner.call("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(r.digest)});
  assert.equal(approved.state,"approved");assert.equal((await owner.call("__tick")).executions,0);
  const snapshot={...baseSnapshot(),active:0,drainRequestId:r.requestId,drainExpiresAt:r.expiresAt};
  await owner.call("__snapshot",{...snapshot,awaitingApproval:1});assert.equal((await owner.call("__tick")).executions,0);
  await owner.call("__snapshot",{...snapshot,drainRequestId:""});assert.equal((await owner.call("__tick")).executions,0);
  await owner.call("__snapshot",snapshot);assert.equal((await owner.call("__tick")).executions,1);
  const result=await owner.call("receipt",{requestId:r.requestId});assert.equal(result.state,"completed");
  assert.deepEqual(result.history.map((x:any)=>x.state),["accepted","approved","dispatching","running","completed"]);
  assert.equal(result.evidence.newPid,8102);assert.equal(result.evidence.remoteHostVerified,false);
  await owner.call("__restart");assert.deepEqual(await owner.call("request",args),result);
  const reconnected=await ownerFixture(t,owner.root);assert.deepEqual(await reconnected.call("receipt",{requestId:r.requestId}),result);
  await reconnected.call("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(r.digest)});
  assert.equal((await reconnected.call("__tick")).executions,0,"signed replay cannot rearm terminal receipt");
  const persisted=JSON.parse(await readFile(join(owner.root,"receipts.json"),"utf8"));assert.equal(persisted.receipts[0].state,"completed");
});

test("R1 stale build/owner, expiry, limits, crash and uncertain controller outcome fail closed",async t=>{
  for(const scenario of ["changed-build","owner-unknown","recent-scope","expire","crash","failure","post-failure","schema-auth-required","restart-approved"]){
    await t.test(scenario,async sub=>{
      const owner=await ownerFixture(sub);const {receipt:r}=await request(owner);
      if(scenario==="expire"){
        const expired=await owner.call("__expire");await rejected(owner.call("challenge",{requestId:r.requestId,digest:expired.digest}),"REQUEST_EXPIRED");
        await owner.call("__tick");assert.equal((await owner.call("receipt",{requestId:r.requestId})).state,"failed");return;
      }
      await owner.call("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(r.digest)});
      if(scenario==="restart-approved"){await owner.call("__restart");assert.equal((await owner.call("receipt",{requestId:r.requestId})).code,"OWNER_RESTARTED_REAPPROVAL_REQUIRED");return;}
      const snapshot={...baseSnapshot(),active:0,drainRequestId:r.requestId,drainExpiresAt:r.expiresAt};
      if(scenario==="changed-build")snapshot.targetBuildId="3333333333333333";
      if(scenario==="owner-unknown")snapshot.ownerVerified=false;
      if(scenario==="recent-scope")snapshot.scope="recent";
      await owner.call("__snapshot",snapshot);await owner.call("__mode",{mode:scenario});
      if(scenario==="crash"){
        await assert.rejects(owner.call("__tick"),/fixture exited 17/);
        const next=await ownerFixture(sub,owner.root);const receipt=await next.call("receipt",{requestId:r.requestId});assert.equal(receipt.state,"unknown");
        assert.equal((await next.call("__tick")).executions,0);return;
      }
      const tick=await owner.call("__tick");const end=await owner.call("receipt",{requestId:r.requestId});
      if(scenario==="schema-auth-required"){assert.equal(end.state,"completed");assert.equal(end.code,"LOCAL_RELOAD_VERIFIED_SCHEMA_PENDING");}
      else if(["failure","post-failure"].includes(scenario)){assert.equal(end.state,"unknown");assert.equal((await owner.call("__tick")).executions,1);}
      else {assert.equal(end.state,"failed");assert.equal(tick.executions,0);}
    });
  }
  const full=await ownerFixture(t);await full.call("__capacity");
  await rejected(full.call("request",{idempotencyKey:randomUUID(),previewDigest:"1".repeat(64),ttlSeconds:900}),"RECEIPT_LIMIT");
});

test("R1 JobStore admission fence serializes with in-flight admissions and full health sees old jobs/approvals",async t=>{
  const root=await mkdtemp(join(tmpdir(),"r1-jobs-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new JobStore(root);await store.initialize();
  const project={id:"test",name:"Test",path:root};
  const preview=previewWorkPackage({projectId:project.id,title:"R1",objective:"synthetic",context:"",acceptanceCriteria:[],constraints:[],executionMode:"plan",dataClassification:"personal"});
  const input={project,workPackage:preview.workPackage,previewDigest:preview.previewDigest,idempotencyKey:randomUUID()};
  const creating=store.create(input);const fencing=store.beginSelfReload(randomUUID(),new Date(Date.now()+60000).toISOString());
  await Promise.all([creating,fencing]);assert.equal(store.listAll().length,1);
  await assert.rejects(store.create({...input,idempotencyKey:randomUUID()}),/SELF_RELOAD_DRAINING/);
  const {record}=await creating;await assert.rejects(store.prepareTurn(record.id,{executionMode:"plan",approvalReviewer:"user",dataClassification:"personal"}),/SELF_RELOAD_DRAINING/);
  const runtime={store,config:{maxRecentJobs:0,projects:new Map(),buildId:"1".repeat(16)},controller:{status:"ready"}} as unknown as BridgeRuntime;
  const health=healthPayload(runtime);assert.equal(health.jobs.active,1);assert.equal(health.jobs.totalVisible,0);assert.equal(health.jobs.scope,"all");
  assert.ok(health.selfReload.drain);await store.endSelfReload(store.selfReloadDrain!.requestId);
  await store.create({...input,idempotencyKey:randomUUID()});assert.equal(store.listAll().length,2);
});

test("R1 MCP/HTTP app-only exact approval drives real synthetic owner, survives Bridge transport restart",async t=>{
  const owner=await ownerFixture(t);let drain:any=null;
  const store={get selfReloadDrain(){return drain;},beginSelfReload:async(requestId:string,expiresAt:string)=>{drain={requestId,expiresAt};},endSelfReload:async()=>{drain=null;}};
  const reload=new SelfReloadClient(store,owner.call);t.after(()=>reload.close());
  const runtime={selfReload:reload,selfReloadHtml:await readFile("web/self-reload.html","utf8"),privilegedBroker:RemotePrivilegedBroker.notConfigured(),widgetHtml:"",close:async()=>{}} as unknown as BridgeRuntime;
  const handle=await startBridgeHttpServer(runtime,{host:"127.0.0.1",port:0,bearerToken:"fixture-only"});t.after(()=>handle.close());
  const client=new Client({name:"r1",version:"1"});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url),{requestInit:{headers:{authorization:"Bearer fixture-only"}}}));
  const tools=(await client.listTools()).tools.filter(x=>x.name.startsWith("codex_self_reload_"));assert.equal(tools.length,6);
  for(const tool of tools){assert.equal(tool.inputSchema.additionalProperties,false);
    assert.equal(tool.annotations?.readOnlyHint,!["codex_self_reload_request","codex_self_reload_approve"].includes(tool.name));}
  for(const name of ["challenge","approve"])assert.deepEqual((tools.find(x=>x.name===`codex_self_reload_${name}`)!._meta as any).ui.visibility,["app"]);
  const rpc=async(op:string,args:Record<string,unknown>={})=>client.callTool({name:"codex_self_reload_"+op,arguments:args});
  for(const forbidden of [{command:"whoami"},{component:"omi_search"},{human:true},{env:{}},{cwd:"C:\\"}])assert.equal((await rpc("preview",forbidden)).isError,true);
  assert.equal((await fetch(handle.url,{method:"POST",headers:{"content-type":"application/json"},body:'{}'})).status,401);
  const p=(await rpc("preview")).structuredContent as any;let r=(await rpc("request",{previewDigest:p.previewDigest,idempotencyKey:randomUUID(),ttlSeconds:900})).structuredContent as any;
  const bad=await rpc("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(String(r.digest),{origin:"https://evil.example"})});assert.equal(bad.isError,true);assert.equal(drain,null);
  assert.equal((await owner.call("receipt",{requestId:r.requestId})).state,"failed");
  r=(await rpc("request",{previewDigest:p.previewDigest,idempotencyKey:randomUUID(),ttlSeconds:900})).structuredContent as any;
  const approved=await rpc("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(String(r.digest))});assert.equal((approved.structuredContent as any).state,"approved");assert.equal((drain as any).requestId,r.requestId);
  await owner.call("__snapshot",{...baseSnapshot(),active:0,drainRequestId:r.requestId,drainExpiresAt:r.expiresAt});await owner.call("__tick");
  await client.close();const again=new Client({name:"reconnect",version:"1"});t.after(()=>again.close());
  await again.connect(new StreamableHTTPClientTransport(new URL(handle.url),{requestInit:{headers:{authorization:"Bearer fixture-only"}}}));
  assert.equal(((await again.callTool({name:"codex_self_reload_receipt",arguments:{requestId:r.requestId}})).structuredContent as any).state,"completed");
  assert.equal(drain,null);assert.equal((await again.listTools()).tools.length>=tools.length,true);
});

test("R1 absent independent owner is explicit NOT_DEPLOYED and never starts a worker",async t=>{
  const server=createCodexBridgeMcpServer({privilegedBroker:RemotePrivilegedBroker.notConfigured()} as BridgeRuntime);
  const client=new Client({name:"not-deployed",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await server.connect(b);await client.connect(a);
  const r=await client.callTool({name:"codex_self_reload_status",arguments:{}});assert.equal((r.structuredContent as any).deployment,"NOT_DEPLOYED");
  assert.equal((await client.callTool({name:"codex_self_reload_preview",arguments:{}})).isError,true);
});

test("R1 pending approval + concurrent accepted receipt never opens admission; rejected delivery resolves durably",async t=>{
  const root=await mkdtemp(join(tmpdir(),"r1-barrier-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new JobStore(root);await store.initialize();
  const r={requestId:randomUUID(),digest:"1".repeat(64),state:"accepted",expiresAt:new Date(Date.now()+60000).toISOString()};
  let release!:(value:ReloadReply)=>void;let reject!:(error:Error)=>void;let reached!:()=>void;
  const entered=new Promise<void>(resolve=>reached=resolve);
  const pending=new Promise<ReloadReply>((resolve,rejectFn)=>{release=resolve;reject=rejectFn;});
  const reload=new SelfReloadClient(store,async(op)=>{if(op==="approve"){reached();return pending;}if(op==="resolve"){r.state="failed";}return {...r};});
  t.after(()=>reload.close());
  const approval=reload.call("approve",{requestId:r.requestId,digest:r.digest,assertion:{}});
  await entered;assert.equal((await reload.call("receipt",{requestId:r.requestId})).state,"accepted");
  assert.ok(store.selfReloadDrain);
  const project={id:"test",name:"Test",path:root};const p=previewWorkPackage({projectId:"test",title:"Fence",objective:"Must be rejected"});
  await assert.rejects(store.create({project,workPackage:p.workPackage,previewDigest:p.previewDigest,idempotencyKey:randomUUID()}),/SELF_RELOAD_DRAINING/);
  await rejected(reload.call("approve",{requestId:r.requestId,digest:r.digest}),"APPROVAL_IN_FLIGHT");
  reject(new ReloadError("OWNER_UNAVAILABLE"));await rejected(approval,"OWNER_UNAVAILABLE");
  assert.equal(store.selfReloadDrain,null);assert.equal(r.state,"failed");
  await store.create({project,workPackage:p.workPackage,previewDigest:p.previewDigest,idempotencyKey:randomUUID()});
});

test("R1 actual write/replace failure poisons owner and executes zero times even after filesystem recovery",async t=>{
  for(const mode of ["write","replace"]){
    for(const phase of ["approval","dispatch"]){
      await t.test(`${mode}/${phase}`,async sub=>{
        const owner=await ownerFixture(sub);const {receipt:r}=await request(owner);
        if(phase==="dispatch"){
          await owner.call("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(r.digest)});
          await owner.call("__snapshot",{...baseSnapshot(),active:0,drainRequestId:r.requestId,drainExpiresAt:r.expiresAt});
        }
        await owner.call("__blockWrite",{mode});
        await rejected(phase==="dispatch"?owner.call("__tick"):owner.call("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(r.digest)}),"STORE_CORRUPT");
        const unblocked=await owner.call("__unblockWrite");assert.equal(unblocked.poisoned,true);assert.equal(unblocked.executions,0);
        await rejected(owner.call("__tick"),"STORE_CORRUPT");await rejected(owner.call("receipt",{requestId:r.requestId}),"STORE_CORRUPT");
        await owner.call("__restart");assert.equal((await owner.call("__tick")).executions,0);
        const recovered=await owner.call("receipt",{requestId:r.requestId});assert.equal(recovered.state,phase==="dispatch"?"failed":"accepted");
      });
    }
  }
});

test("R1 wall-clock rollback poisons outstanding grants instead of extending approval TTL",async t=>{
  const owner=await ownerFixture(t);const {receipt:r}=await request(owner);
  await owner.call("approve",{requestId:r.requestId,digest:r.digest,assertion:assertion(r.digest)});
  await owner.call("__snapshot",{...baseSnapshot(),active:0,drainRequestId:r.requestId,drainExpiresAt:r.expiresAt});
  await owner.call("__rollbackClock");await rejected(owner.call("__tick"),"CLOCK_ROLLBACK");
  const state=await owner.call("__unblockWrite");assert.equal(state.poisoned,true);assert.equal(state.executions,0);
  await rejected(owner.call("preview"),"STORE_CORRUPT");
});
