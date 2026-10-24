// OFFLINE RPC regression. The native child and installed activation are mocked;
// this exercises the real receiver/Store/MCP, never OS execution or human consent.
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const build = process.env.NORMAL_TEST_BUILD ? pathToFileURL(resolve(process.env.NORMAL_TEST_BUILD)+"/")
  : new URL("../.tmp/host-diagnostics-check/src/", import.meta.url);
mock.module(new URL("installed-runtime.js", build).href, { namedExports: { assertInstalledRuntimeActivation: async () => {} } });
const { ApprovalStore } = await import(new URL("powershell-approval/store.js", build));
const { createPowerShellHostPort } = await import(new URL("powershell-approval/host-admission.js", build));
const { createNativeHostTransport } = await import(new URL("powershell-approval/host-transport.js", build));
const { registerPowerShellNormalTools } = await import(new URL("powershell-approval/normal-tools.js", build));
const { registerPowerShellReceiptTools } = await import(new URL("powershell-approval/receipt-tools.js", build));
const { normalOutputSchema, validateNormalOutput, pageNormalOutput } = await import(new URL("powershell-approval/normal-output.js", build));
const { digest, productionRequestSchema } = await import(new URL("powershell-approval/contract.js", build));
const { validatePowerShellScope } = await import(new URL("powershell-approval/review-tools.js", build));
const { startBridgeHttpServer } = await import(new URL("http-server.js", build));
const flush = () => new Promise(resolve => setImmediate(resolve));
const peer = { hostId: randomUUID(), instanceId: randomUUID(), sid: "S-1-5-21-1000", logonId: "0000000000000001",
  pid: 123, processStartedAt: Date.now()-10000, imageSha256: "b".repeat(64), tokenId: "offline-token", integrity: "MEDIUM" };

function output(stdout="offline result 中文\r\n", stderr="") {
  const a=Buffer.from(stdout), b=Buffer.from(stderr), x=Buffer.alloc(4), y=Buffer.alloc(4);
  x.writeUInt32LE(a.length);y.writeUInt32LE(b.length);
  return { value:{stdoutBase64:a.toString("base64"),stderrBase64:b.toString("base64")},
    hash:createHash("sha256").update(Buffer.concat([x,a,y,b])).digest("hex"), a:a.length,b:b.length };
}
async function setup(t, mode="NORMAL", inline=false) {
  const base=resolve(process.env.NORMAL_TEST_ROOT ?? ".tmp/normal-flow-tests");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"case-"));
  const store=await ApprovalStore.open(join(root,"approval"));
  const project={id:"personal",name:"Personal",path:join(root,"project")};await mkdir(project.path);
  const readJob=async()=>assert.fail("DIRECT must not read JobStore");
  const projects=new Map([[project.id,project]]), port=createPowerShellHostPort({store,projects,readJob});
  const reviewInput={origin:"DIRECT",projectId:project.id,dataClassification:"personal",idempotencyKey:randomUUID(),
    userIntent:"EXPLICIT_USER_REQUEST",contentPolicy:"PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS",executionMode:mode,
    cwd:root,target:"offline test",scriptSnapshot:"[Console]::Out.WriteLine('NORMAL_E2E_OK')",args:["","literal"],risk:"offline",sideEffects:"none"};
  let review=inline ? undefined : await store.createReview(reviewInput);
  const frames=[];let child;
  const spawn=t.mock.method(childProcess,"spawn",()=>{
    frames.length=0;child=new EventEmitter();child.pid=111;child.exitCode=null;
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,encoding,done){frames.push(JSON.parse(String(chunk)));done();}});
    return child;
  });syncBuiltinESMExports();
  const installed={codeRoot:"C:\\offline-installed"};const transport=createNativeHostTransport(port,installed);
  const httpToken=randomUUID()+randomUUID();
  const runtime={approvalStore:store,powershellHostTransport:transport,config:{projects,installedBinding:installed,httpToken},store:{snapshot:readJob}};
  const server=new McpServer({name:"offline-normal",version:"1"});registerPowerShellNormalTools(server,runtime);registerPowerShellReceiptTools(server,store,readJob);
  const client=new Client({name:"offline-normal",version:"1"}), [a,b]=InMemoryTransport.createLinkedPair();
  let authenticated=true;
  const sendAuthenticated=a.send.bind(a);
  a.send=(message,options)=>sendAuthenticated(message,{...options,...(authenticated ? {authInfo:{token:httpToken,clientId:"fixture",scopes:[]}} : {})});
  await server.connect(b);await client.connect(a);
  const exit=()=>{if(!child)return;child.exitCode=0;child.emit("exit",0);};
  t.after(async()=>{exit();await transport.close();await client.close();await server.close();await store.close();spawn.mock.restore();syncBuiltinESMExports();});
  const send=m=>child.stdout.write(JSON.stringify(m)+"\n");
  const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}assert.fail("offline frame timeout");};
  const {userIntent:ignored,...candidate}=reviewInput;
  const call=(patch={})=>client.callTool({name:"codex_powershell_normal_execute",arguments:{
    ...(inline ? {request:candidate} : {requestId:review.request.requestId,digest:review.digest}),
    userIntent:"EXPLICIT_USER_EXECUTION_REQUEST",...patch}});
  let sequence=0;
  const rpc=async(operation,payload)=>{
    const n=frames.length, initial=frames[0];
    send({contract:"powershell-host-rpc-v1",session:initial.session,expiresAt:initial.expiresAt,channelBinding:"a".repeat(64),sequence:++sequence,message:{operation,payload}});
    await wait(()=>frames.length>n);return frames.at(-1);
  };
  const start=async(invoke=call)=>{
    sequence=0;frames.length=0;const pending=invoke();await wait(()=>frames.length>0);
    if(inline) review=await store.readReviewByIdempotencyKey(candidate.idempotencyKey);
    send({kind:"channel",session:frames[0].session,binding:"a".repeat(64),peer});await wait(()=>frames.length>1);
    const prepared=await rpc("prepare",{requestId:review.request.requestId,digest:review.digest});assert.ok(prepared.result);
    return {pending,prepared:prepared.result};
  };
  const proposal=snapshot=>{
    const r=review.request, at=Date.now();
    return productionRequestSchema.parse({version:2,evidence:"PRODUCTION",policy:"powershell-approval-production-v1",origin:"DIRECT",
      requestId:randomUUID(),receiptId:randomUUID(),idempotencyKey:randomUUID(),bootId:snapshot.bootId,
      ...Object.fromEntries(["projectId","executionMode","target","scriptSnapshot","scriptSha256","scriptEncoding","cwd","args","risk","sideEffects"].map(k=>[k,r[k]])),
      environmentPolicyDigest:snapshot.policyDigest,createdAt:at,ttlMs:120000,expiresAt:at+120000,nonce:randomUUID(),
      sourceReview:{requestId:r.requestId,digest:review.digest},approvalIdentity:{authority:peer,subjectSid:peer.sid,ceremonyId:randomUUID(),interface:"REMOTE_MCP_REQUEST",authentication:"AUTHENTICATED_DIRECT_REQUEST"},
      executorIdentity:peer,admission:{source:"WINDOWS_HOST_PEER",observationId:randomUUID(),channelBinding:"a".repeat(64),observedAt:at,peer}});
  };
  const observe=()=>({source:"WINDOWS_HOST_PEER",observationId:randomUUID(),channelBinding:"a".repeat(64),observedAt:Date.now(),peer});
  const complete=async(code)=>{send({kind:"complete",session:frames[0].session,code});await flush();exit();};
  return {store,get review(){return review;},client,call,spawn,transport,frames,rpc,start,proposal,observe,complete,exit,
    candidate,root,projects,readJob,runtime,authenticate:value=>{authenticated=value;},
    nextReview:async()=>{review=await store.createReview({...reviewInput,idempotencyKey:randomUUID()});},
    journal:()=>readFile(join(root,"approval/receipts.jsonl"),"utf8")};
}

test("single explicit MCP request creates original Review and durable claim without review_get/decide",async t=>{
  const f=await setup(t,"NORMAL",true), {pending,prepared}=await f.start(), request=f.proposal(prepared);
  assert.equal(f.review.state,"PENDING");assert.equal(f.review.revision,1);
  assert.equal(f.review.request.cwd,f.root);assert.notEqual(f.root,f.projects.get("personal").path);
  let r=await f.rpc("admit",request);assert.equal(r.result.state,"PROPOSED");
  const binding={requestId:request.requestId,digest:r.result.digest};
  r=await f.rpc("decide",{...binding,decision:"APPROVED",observation:f.observe()});assert.equal(r.result.state,"APPROVED");
  r=await f.rpc("claim",{...binding,observation:f.observe()});assert.equal(r.result.state,"CONSUMED");
  assert.match(await f.journal(),/GRANT_CONSUMED/);
  const result=output(), executor=f.observe(), consumed=r.result;
  const observation={...binding,grantId:consumed.grant.grantId,consumptionId:consumed.consumption.consumptionId,outcome:"SUCCEEDED",reason:"PROCESS_EXITED",exitCode:0,
    outputSha256:result.hash,sid:peer.sid,logonId:peer.logonId,processId:987,session:1,startedUtcTicks:String(BigInt(Date.now())*10000n+621355968000000000n),completedAt:executor.observedAt,
    elevated:false,stdoutBytes:result.a,stderrBytes:result.b,outputTruncated:false,verification:"OS_OBSERVATION_ONLY_NOT_INGESTED"};
  r=await f.rpc("ingestNormal",{observation,executor,output:result.value});assert.ok(r.result.osExecutionReceipt);
  await f.complete("RECEIPT_RECORDED");const completed=await pending;
  assert.equal(completed.structuredContent.code,"RECEIPT_RECORDED");
  assert.equal(completed.structuredContent.receipt.osExecutionReceipt.exitCode,0);
  assert.equal(completed.structuredContent.receipt.hostApproval.recordedInterface,"REMOTE_MCP_REQUEST");
  assert.equal(completed.structuredContent.receipt.osExecutionReceipt.output.stdout,"offline result 中文\r\n");
  assert.doesNotMatch(await f.journal(),/offline result|stdoutBase64|stderrBase64/);
  const saved=await f.client.callTool({name:"codex_powershell_receipt",arguments:{requestId:f.review.request.requestId}});
  assert.equal(saved.structuredContent.osExecutionReceipt.output.stdout,"offline result 中文\r\n");
  const recovered=await f.client.callTool({name:"codex_powershell_receipt",arguments:{idempotencyKey:f.candidate.idempotencyKey}});
  assert.equal(recovered.structuredContent.requestId,f.review.request.requestId);
  assert.equal(recovered.structuredContent.digest,f.review.digest);
  const again=await f.call();assert.equal(again.structuredContent.code,"EXECUTION_ALREADY_REQUESTED");assert.equal(f.spawn.mock.callCount(),1);
  t.mock.timers.enable({apis:["Date","setTimeout"]});t.mock.timers.tick(600001);
  assert.equal(f.store.readProductionOutput(request.requestId).availability,"UNAVAILABLE_OR_EXPIRED");
  const before=await f.journal();
  assert.equal((await f.store.readReviewByIdempotencyKey(f.candidate.idempotencyKey)).request.requestId,f.review.request.requestId);
  assert.equal(await f.journal(),before);
  t.mock.timers.reset();
});

test("strict exactly-one execution input rejects malformed/forged requests before Store or transport",async t=>{
  const f=await setup(t,"NORMAL",true), before=await f.journal();
  const intent={userIntent:"EXPLICIT_USER_EXECUTION_REQUEST"};
  for(const input of [intent, {...intent,requestId:randomUUID()}, {...intent,digest:"a".repeat(64)},
    {...intent,request:f.candidate,requestId:randomUUID(),digest:"a".repeat(64)},
    {...intent,request:{...f.candidate,approved:true}}, {...intent,request:{...f.candidate,origin:"CODEX_DERIVED"}},
    {...intent,request:{...f.candidate,executionMode:"ADMIN"}}, {...intent,request:{...f.candidate,args:[null]}},
    {...intent,request:{...f.candidate,dataClassification:"company_approved"}},
    {...intent,request:{...f.candidate,scriptSnapshot:"password = hidden"}},
    {...intent,request:{...f.candidate,jobId:randomUUID()}}, {...intent,request:{...f.candidate,cwd:"relative"}}]) {
    assert.equal((await f.client.callTool({name:"codex_powershell_normal_execute",arguments:input})).isError,true);
  }
  assert.equal(await f.journal(),before);assert.equal(f.spawn.mock.callCount(),0);
  for(const input of [{}, {requestId:randomUUID(),idempotencyKey:randomUUID()}])
    assert.equal((await f.client.callTool({name:"codex_powershell_receipt",arguments:input})).isError,true);
});

test("inline idempotency preserves exact bytes, conflicts, concurrency and UNKNOWN across Store reopen",async t=>{
  const f=await setup(t,"NORMAL",true),{pending,prepared}=await f.start(),request=f.proposal(prepared);
  assert.equal((await f.call({request:{...f.candidate,args:["changed"]}})).structuredContent.code,"IDEMPOTENCY_CONFLICT");
  assert.equal((await f.call()).structuredContent.code,"HOST_TRANSPORT_BUSY");
  const admitted=await f.rpc("admit",request),binding={requestId:request.requestId,digest:admitted.result.digest};
  await f.rpc("decide",{...binding,decision:"APPROVED",observation:f.observe()});
  await f.rpc("claim",{...binding,observation:f.observe()});f.exit();await pending;
  assert.equal((await f.call()).structuredContent.code,"EXECUTION_ALREADY_REQUESTED");
  const original=f.review.request.requestId;await f.store.close();
  const reopened=await ApprovalStore.open(join(f.root,"approval"));
  try {
    assert.equal((await reopened.readReviewByIdempotencyKey(f.candidate.idempotencyKey)).request.requestId,original);
    assert.equal((await reopened.readReviewExecution(original)).state,"UNKNOWN");
    const before=await f.journal();
    await reopened.readReviewByIdempotencyKey(f.candidate.idempotencyKey);
    assert.equal(await f.journal(),before);
  } finally {await reopened.close();}
  assert.equal(f.spawn.mock.callCount(),1);
});

test("DIRECT NORMAL outside project is scoped separately from ADMIN and CODEX_DERIVED",async t=>{
  const f=await setup(t,"NORMAL",true),context={store:f.store,projects:f.projects,readJob:f.readJob};
  const candidate={...f.candidate,userIntent:"EXPLICIT_USER_REQUEST"};
  await validatePowerShellScope(candidate,context);
  for(const patch of [{executionMode:"ADMIN"},{origin:"CODEX_DERIVED",jobId:randomUUID(),turnId:"turn"},
    {projectId:"unknown"},{cwd:join(f.root,"missing")},{cwd:"C:relative"},{cwd:"\\root-relative"}])
    await assert.rejects(validatePowerShellScope({...candidate,...patch},context),/REVIEW_SCOPE_REJECTED/);
});

test("real isolated HTTP MCP supplies verified per-request auth; wrong/missing bearer and forged metadata fail",async t=>{
  const f=await setup(t,"NORMAL",true);f.runtime.close=async()=>{};
  const handle=await startBridgeHttpServer(f.runtime,{host:"127.0.0.1",port:0,bearerToken:f.runtime.config.httpToken});
  t.after(()=>handle.close());
  const clients=[];t.after(async()=>{for(const c of clients)await c.close();});
  const connect=async token=>{
    const client=new Client({name:"isolated-http",version:"1"});clients.push(client);
    const transport=new StreamableHTTPClientTransport(new URL(handle.url),{requestInit:{headers:token?{Authorization:`Bearer ${token}`}:{}}});
    await client.connect(transport);return {client,transport};
  };
  for(const token of [undefined,"wrong-offline-bearer"]) await assert.rejects(connect(token));
  const {client,transport}=await connect(f.runtime.config.httpToken);
  const args={request:f.candidate,userIntent:"EXPLICIT_USER_EXECUTION_REQUEST"};
  // A valid session does not authenticate a subsequent HTTP request.
  for(const auth of [undefined,"wrong-offline-bearer"]) {
    const response=await fetch(handle.url,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",
      "mcp-session-id":transport.sessionId,...(auth?{Authorization:`Bearer ${auth}`}:{})},
      body:JSON.stringify({jsonrpc:"2.0",id:99,method:"tools/call",params:{name:"codex_powershell_normal_execute",arguments:args}})});
    assert.equal(response.status,401);await response.text();
  }
  for(const arguments_ of [{userIntent:args.userIntent},{...args,requestId:randomUUID(),digest:"a".repeat(64)}])
    assert.equal((await client.callTool({name:"codex_powershell_normal_execute",arguments:arguments_})).isError,true);
  assert.equal(f.spawn.mock.callCount(),0);
  const {pending,prepared}=await f.start(()=>client.callTool({name:"codex_powershell_normal_execute",arguments:args}));
  const request=f.proposal(prepared), admitted=await f.rpc("admit",request),binding={requestId:request.requestId,digest:admitted.result.digest};
  await f.rpc("decide",{...binding,decision:"APPROVED",observation:f.observe()});
  const consumed=(await f.rpc("claim",{...binding,observation:f.observe()})).result;
  const captured=output("HTTP stdout 中文\r\n","HTTP stderr\r\n"),executor=f.observe();
  const observation={...binding,grantId:consumed.grant.grantId,consumptionId:consumed.consumption.consumptionId,
    outcome:"FAILED",reason:"PROCESS_EXITED",exitCode:7,outputSha256:captured.hash,sid:peer.sid,logonId:peer.logonId,
    processId:987,session:1,startedUtcTicks:String(BigInt(Date.now())*10000n+621355968000000000n),completedAt:executor.observedAt,
    elevated:false,stdoutBytes:captured.a,stderrBytes:captured.b,outputTruncated:false,verification:"OS_OBSERVATION_ONLY_NOT_INGESTED"};
  assert.ok((await f.rpc("ingestNormal",{observation,executor,output:captured.value})).result.osExecutionReceipt);
  await f.complete("RECEIPT_RECORDED");
  const result=await pending;assert.equal(result.structuredContent.code,"RECEIPT_RECORDED");
  assert.equal(result.structuredContent.receipt.osExecutionReceipt.exitCode,7);
  assert.equal(result.structuredContent.receipt.osExecutionReceipt.output.stderr,"HTTP stderr\r\n");
  const saved=await client.callTool({name:"codex_powershell_receipt",arguments:{idempotencyKey:f.candidate.idempotencyKey}});
  assert.equal(saved.structuredContent.requestId,f.review.request.requestId);
  assert.equal(saved.structuredContent.osExecutionReceipt.output.stdout,"HTTP stdout 中文\r\n");
  assert.ok(!JSON.stringify(result).includes(f.runtime.config.httpToken));
  assert.equal(f.spawn.mock.callCount(),1);
});

test("tokenless HTTP/tunnel-only and unauthenticated in-memory callers cannot authorize NORMAL",async t=>{
  const f=await setup(t,"NORMAL",true),before=await f.journal();f.authenticate(false);
  assert.equal((await f.call()).structuredContent.code,"AUTHENTICATED_MCP_REQUIRED");
  f.runtime.close=async()=>{};
  const handle=await startBridgeHttpServer(f.runtime,{host:"127.0.0.1",port:0});t.after(()=>handle.close());
  const client=new Client({name:"no-bearer",version:"1"});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
  const result=await client.callTool({name:"codex_powershell_normal_execute",arguments:{request:f.candidate,userIntent:"EXPLICIT_USER_EXECUTION_REQUEST"},
    _meta:{authInfo:{token:f.runtime.config.httpToken},authenticated:true}});
  assert.equal(result.structuredContent.code,"AUTHENTICATED_MCP_REQUIRED");
  assert.equal(await f.journal(),before);assert.equal(f.spawn.mock.callCount(),0);
});

test("offline lost claim response/child exit yields durable UNKNOWN and no second execution",async t=>{
  const f=await setup(t),{pending,prepared}=await f.start(),request=f.proposal(prepared);
  const admitted=await f.rpc("admit",request), binding={requestId:request.requestId,digest:admitted.result.digest};
  await f.rpc("decide",{...binding,decision:"APPROVED",observation:f.observe()});
  await f.rpc("claim",{...binding,observation:f.observe()});f.exit();
  const result=await pending;assert.equal(result.structuredContent.code,"HOST_TRANSPORT_UNKNOWN");
  assert.equal((await f.store.readReviewExecution(f.review.request.requestId)).state,"UNKNOWN");
  assert.equal((await f.call()).structuredContent.code,"EXECUTION_ALREADY_REQUESTED");assert.equal(f.spawn.mock.callCount(),1);
});

test("offline local decline is durable, never claims or dispatches on another invocation",async t=>{
  const f=await setup(t),{pending,prepared}=await f.start(),request=f.proposal(prepared);
  const admitted=await f.rpc("admit",request), binding={requestId:request.requestId,digest:admitted.result.digest};
  const denied=await f.rpc("decide",{...binding,decision:"DENIED",observation:f.observe()});assert.equal(denied.result.state,"DENIED");
  await f.complete("HOST_APPROVAL_DECLINED");await pending;
  assert.equal((await f.call()).structuredContent.code,"EXECUTION_ALREADY_REQUESTED");assert.equal(f.spawn.mock.callCount(),1);
  assert.doesNotMatch(await f.journal(),/GRANT_CONSUMED/);
});

test("offline changed OS peer is rejected by the real Store before admitting a request",async t=>{
  const f=await setup(t),{pending,prepared}=await f.start(),request=f.proposal(prepared);
  request.executorIdentity={...peer,pid:124};
  const refused=await f.rpc("admit",request);assert.equal(refused.error,"BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED");
  f.exit();await pending;assert.equal(f.store.listProduction().length,0);
});

test("offline duplicate claim is rejected and permanently lowers the consumed request to UNKNOWN",async t=>{
  const f=await setup(t),{pending,prepared}=await f.start(),request=f.proposal(prepared);
  const admitted=await f.rpc("admit",request),binding={requestId:request.requestId,digest:admitted.result.digest};
  await f.rpc("decide",{...binding,decision:"APPROVED",observation:f.observe()});
  await f.rpc("claim",{...binding,observation:f.observe()});
  const replay=await f.rpc("claim",{...binding,observation:f.observe()});assert.equal(replay.error,"INVALID_TRANSITION");
  f.exit();await pending;assert.equal((await f.store.readReviewExecution(f.review.request.requestId)).state,"UNKNOWN");
  assert.equal((await f.call()).structuredContent.code,"EXECUTION_ALREADY_REQUESTED");
});

test("MCP rejects tool authorization flags and ADMIN without starting transport",async t=>{
  const f=await setup(t,"ADMIN");
  const forged=await f.client.callTool({name:"codex_powershell_normal_execute",arguments:{requestId:f.review.request.requestId,digest:f.review.digest,userIntent:"EXPLICIT_USER_EXECUTION_REQUEST",approved:true}});
  assert.equal(forged.isError,true);assert.equal((await f.call()).structuredContent.code,"BLOCKED_AWAITING_LOCAL_UAC");assert.equal(f.spawn.mock.callCount(),0);
});

test("complete output preserves exact Unicode hash and rejects changed/noncanonical bytes",()=>{
  const good=output();assert.equal(validateNormalOutput(good.value,good.hash).stdout,"offline result 中文\r\n");
  assert.throws(()=>validateNormalOutput(good.value,"a".repeat(64)),/NORMAL_OUTPUT_REJECTED/);
  const large=output("x".repeat(16385));assert.equal(validateNormalOutput(large.value,large.hash).stdout.length,16385);
  assert.equal(normalOutputSchema.safeParse({stdoutBase64:"!!!!",stderrBase64:""}).success,false);
  assert.throws(()=>validateNormalOutput({stdoutBase64:"AB==",stderrBase64:""},good.hash),/NORMAL_OUTPUT_REJECTED/);
});

test("two independent MCP requests reuse the Host transport and return all paged output",async t=>{
  const f=await setup(t);
  for(let attempt=0;attempt<2;attempt++) {
    if(attempt) await f.nextReview();
    const {pending,prepared}=await f.start(), request=f.proposal(prepared);
    const admitted=await f.rpc("admit",request),binding={requestId:request.requestId,digest:admitted.result.digest};
    await f.rpc("decide",{...binding,decision:"APPROVED",observation:f.observe()});
    const consumed=(await f.rpc("claim",{...binding,observation:f.observe()})).result;
    // More than the old 16 KiB output limit and 32-frame ceiling, with Unicode
    // crossing both native chunks and receipt page boundaries.
    const stdout="a".repeat(8191)+"😀中文".repeat(100000),stderr="error 尾端\r\n";
    const result=output(stdout,stderr);
    for(const [stream,text] of [["stdout",stdout],["stderr",stderr]]) {
      const bytes=Buffer.from(text);
      for(let offset=0;offset<bytes.length;offset+=12288) {
        const part=bytes.subarray(offset,offset+12288);
        const accepted=await f.rpc("output",{...binding,stream,offset,dataBase64:part.toString("base64")});
        assert.equal(accepted.result.receivedBytes,offset+part.length);
      }
    }
    const executor=f.observe(),observation={...binding,grantId:consumed.grant.grantId,consumptionId:consumed.consumption.consumptionId,
      outcome:"SUCCEEDED",reason:"PROCESS_EXITED",exitCode:0,outputSha256:result.hash,sid:peer.sid,logonId:peer.logonId,
      processId:987+attempt,session:1,startedUtcTicks:String(BigInt(Date.now())*10000n+621355968000000000n),completedAt:executor.observedAt,
      elevated:false,stdoutBytes:result.a,stderrBytes:result.b,outputTruncated:false,verification:"OS_OBSERVATION_ONLY_NOT_INGESTED"};
    await f.rpc("ingestNormal",{observation,executor});await f.complete("RECEIPT_RECORDED");
    const completed=await pending;assert.equal(completed.structuredContent.code,"RECEIPT_RECORDED");
    let page=completed.structuredContent.receipt.osExecutionReceipt.output,a=page.stdout,b=page.stderr;
    while(page.nextOffset!==null) {
      const read=await f.client.callTool({name:"codex_powershell_receipt",arguments:{requestId:f.review.request.requestId,outputOffset:page.nextOffset}});
      page=read.structuredContent.osExecutionReceipt.output;a+=page.stdout;b+=page.stderr;
    }
    assert.equal(a,stdout);assert.equal(b,stderr);
    assert.equal(f.transport.status().closed,false);
    assert.equal((await f.call()).structuredContent.code,"EXECUTION_ALREADY_REQUESTED");
    assert.equal(f.spawn.mock.callCount(),attempt+1);
  }
});

test("chunk gaps are rejected without ingest and consumed requests remain UNKNOWN",async t=>{
  const f=await setup(t),{pending,prepared}=await f.start(),request=f.proposal(prepared);
  const admitted=await f.rpc("admit",request),binding={requestId:request.requestId,digest:admitted.result.digest};
  await f.rpc("decide",{...binding,decision:"APPROVED",observation:f.observe()});
  await f.rpc("claim",{...binding,observation:f.observe()});
  const bad=await f.rpc("output",{...binding,stream:"stdout",offset:1,dataBase64:"YQ=="});
  assert.equal(bad.error,"NORMAL_OUTPUT_REJECTED");f.exit();await pending;
  assert.equal((await f.store.readReviewExecution(f.review.request.requestId)).state,"UNKNOWN");
});

test("output pages preserve surrogate pairs and validate offsets",()=>{
  const r=output("a".repeat(8191)+"😀", "尾端"),text=validateNormalOutput(r.value,r.hash);
  const page=pageNormalOutput(text);assert.equal(page.stdout,"a".repeat(8191));
  const next=pageNormalOutput(text,page.nextOffset);assert.equal(next.stdout,"😀");assert.equal(next.stderr,"尾端");
  assert.equal(next.nextOffset,null);
  assert.throws(()=>pageNormalOutput(text,8192),/OUTPUT_OFFSET_INVALID/);
  assert.throws(()=>pageNormalOutput(text,99999),/OUTPUT_OFFSET_INVALID/);
});
