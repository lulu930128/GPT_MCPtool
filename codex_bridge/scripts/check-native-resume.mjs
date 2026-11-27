// Offline Responses fixture for the pinned Windows binary. Run from codex_bridge after build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "../dist/src/app-server-client.js";
import { loadBridgeConfig } from "../dist/src/config.js";
import { CodexBridgeController } from "../dist/src/controller.js";
import { JobStore } from "../dist/src/job-store.js";
import { TextBundleStore } from "../dist/src/text-bundle-store.js";
import { previewWorkPackage } from "../dist/src/work-package.js";

const root = await mkdtemp(join(tmpdir(), "bridge-172-resume-"));
const home = join(root, "home"), project = join(root, "project");
await Promise.all([mkdir(home), mkdir(project)]);
const native = resolve("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const environment = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  HOME: home, USERPROFILE: home, CODEX_HOME: home, APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local"),
  TEMP: root, TMP: root, PATH: dirname(process.execPath) + ";" + join(process.env.SystemRoot, "System32") };
process.env.LOCALAPPDATA = environment.LOCALAPPDATA;
const version = spawnSync(native, ["--version"], {env:environment, encoding:"utf8"}).stdout.trim();
assert.equal(version, "codex-cli 0.172.0");
const model = "gpt-6.2-astra";
const requests = [], notes = [], measurements = [], releases = [];
let gate;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push({ model: body.model, effort: body.reasoning?.effort, tier: body.service_tier ?? null });
  if (requests.length === 1) {
    await new Promise(resolve => { gate = resolve; });
    res.writeHead(429, {"Content-Type":"application/json"});
    res.end(JSON.stringify({error:{type:"usage_limit_reached",message:"Fixture usage limit reached",plan_type:"plus",resets_at:1999999999}}));
    return;
  }
  const text = "Fixture complete.";
  const item = {id:"msg_" + randomUUID(), type:"message", role:"assistant", status:"completed",
    content:[{type:"output_text",text,annotations:[]}]};
  const response = {id:"resp_" + randomUUID(), object:"response", created_at:1, model:body.model,
    status:"completed",output:[item],usage:{input_tokens:5,output_tokens:2,total_tokens:7}};
  const events = [
    {type:"response.created",response:{...response,status:"in_progress",output:[]}},
    {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
    {type:"response.output_text.delta",output_index:0,content_index:0,item_id:item.id,delta:text},
    {type:"response.output_item.done",output_index:0,item}, {type:"response.completed",response},
  ];
  res.writeHead(200, {"Content-Type":"text/event-stream"});
  res.end(events.map(e => "event: "+e.type+"\ndata: "+JSON.stringify(e)+"\n\n").join(""));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await writeFile(join(home,"config.toml"), `model_provider="fixture"
model="${model}"
cli_auth_credentials_store="file"
[model_providers.fixture]
name="Fixture"
wire_api="responses"
base_url="http://127.0.0.1:${server.address().port}/v1"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
supports_websockets=false
`);
const projectsFile = join(root, "projects.json");
await writeFile(projectsFile, JSON.stringify({projects:[{id:"fixture",name:"Fixture",path:project}]}));
const config = await loadBridgeConfig({CODEX_HOME:home, CODEX_BRIDGE_PROJECT_ROOT:project, CODEX_BRIDGE_DATA_DIR:join(root,"data"),
  CODEX_BRIDGE_PROJECTS_FILE:projectsFile,CODEX_BRIDGE_CODEX_COMMAND:native});
const makeClient = () => new CodexAppServerClient({command:native,args:config.codexArgs,environment});
// An isolated Windows home has no elevated sandbox setup. The plan execution
// fixture uses native :read-only plus network and contains only synthetic data.
// A separate managed-profile probe below uses the actual Bridge launch args.
const fixtureArgs = ["app-server", "-c", 'default_permissions=":danger-full-access"', "-c", 'permissions.codex-bridge-read-only={extends=":read-only",network={enabled=true}}'];
const fixtureClient = () => new CodexAppServerClient({command:native,args:fixtureArgs,environment});
let client = fixtureClient();
const store = new JobStore(config.jobsDir, config.handoffDir);
await store.initialize();
const bundles = new TextBundleStore(config.stagingDir);
await bundles.initialize();
const connect = () => {
  const request = client.request.bind(client);
  client.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === "thread/unsubscribe") releases.push({threadId:args[1].threadId, status:result.status});
    return result;
  };
  client.on("notification", ({method,params:p}) => {
    if (["turn/started","turn/completed","thread/status/changed","thread/settings/updated"].includes(method))
      notes.push({method,threadId:p.threadId,turnId:p.turn?.id,status:p.turn?.status ?? p.status?.type,
        sandbox:p.threadSettings?.sandboxPolicy?.type,profile:p.threadSettings?.activePermissionProfile?.id});
  });
  return new CodexBridgeController(config,store,bundles,client);
};
let controller = connect();
async function until(check) {
  const end = Date.now()+20000;
  while (!await check()) { assert.ok(Date.now()<end,"fixture observation timeout"); await delay(20); }
}
let jobId, threadId;
const history = () => client.request("thread/turns/list",{threadId,limit:10,itemsView:"full"});
const status = async () => (await client.request("thread/read",{threadId,includeTurns:false})).thread.status.type;
const loaded = async () => (await client.request("thread/loaded/list")).data.includes(threadId);
async function send(id, executionMode, approvalReviewer) {
  const start = performance.now();
  const input = {jobId,clientMessageId:id,content:"Continue fixture",executionMode,approvalReviewer,
    dataClassification:"personal",model,effort:"high"};
  await controller.directMessage(input);
  await until(() => ["completed","failed"].includes(store.get(jobId).status));
  assert.equal(store.get(jobId).status,"completed",store.get(jobId).result?.message);
  const head = (await history()).data[0];
  assert.equal(head.status,"completed");
  assert.ok(head.items.some(i=>i.type==="userMessage" && i.clientId===id));
  assert.equal(store.get(jobId).threadId,threadId);
  assert.equal(store.get(jobId).turnId,head.id);
  assert.equal((await controller.directMessage(input)).delivery,"duplicate");
  measurements.push({id,executionMode,approvalReviewer,turnId:head.id,ms:Math.round(performance.now()-start)});
}
try {
  const preview = previewWorkPackage({projectId:"fixture",title:"Quota fixture",objective:"Return fixture text",model,effort:"high",
    executionMode:"workspace_write",approvalReviewer:"auto_review"});
  const dispatch = await controller.dispatch({source:"model_direct",preview,previewDigest:preview.previewDigest,idempotencyKey:"fixture-quota"});
  jobId = dispatch.record.id;
  await until(()=>gate && store.get(jobId).turnId);
  threadId = store.get(jobId).threadId;
  const priorTurn = store.get(jobId).turnId;
  assert.equal(await status(),"active");
  assert.equal((await history()).data[0].status,"inProgress");
  const peer = fixtureClient();
  const other = new CodexBridgeController(config,store,bundles,peer);
  const preflight = (owner, id) => owner.prepareContinuation(store.get(jobId),threadId,priorTurn,id,"turn",
    ":danger-full-access","auto_review",model,"high");
  try {
    await assert.rejects(preflight(controller,"fixture-active"),/NATIVE_TURN_ACTIVE/);
    await assert.rejects(preflight(other,"fixture-other-writer"),/NATIVE_OTHER_WRITER/);
    const added = await client.request("thread/queue/add",{threadId,clientUserMessageId:"fixture-queued",
      input:[{type:"text",text:"Held work"}]});
    await assert.rejects(preflight(other,"fixture-queue"),/NATIVE_QUEUE_REQUIRES_RECONCILIATION/);
    await client.request("thread/queue/delete",{threadId,queuedSubmissionId:added.queuedSubmission.id});
    await client.request("thread/goal/set",{threadId,status:"active",origin:"user",objective:"Fixture goal",tokenBudget:100});
    await assert.rejects(preflight(other,"fixture-goal"),/NATIVE_GOAL_REQUIRES_RECONCILIATION/);
    await client.request("thread/goal/clear",{threadId,origin:"user"});
  } finally { await other.close(); }
  assert.equal(requests.length,1);
  gate();
  await until(()=>store.get(jobId).status==="failed");
  assert.equal(await status(),"systemError");
  assert.equal((await history()).data[0].id,priorTurn);
  assert.equal((await history()).data[0].status,"failed");
  await controller.releaseIdleSubscription(jobId,threadId);
  assert.equal(releases.length,0);
  const rpc = (method, params={}) => client.request(method,{threadId,...params});
  // Reproduce the installed gate through its first rejected readback.
  await rpc("thread/resume",{excludeTurns:true,permissions:":danger-full-access",approvalsReviewer:"auto_review"});
  await rpc("thread/settings/update",{sandboxPolicy:{type:"dangerFullAccess"},approvalPolicy:"on-request",approvalsReviewer:"auto_review"});
  const old = await rpc("thread/resume",{excludeTurns:true});
  assert.equal(old.thread.id,threadId);
  assert.equal(old.thread.status.type,"systemError");
  assert.equal(old.sandbox.type,"dangerFullAccess");
  assert.equal(old.activePermissionProfile,null);
  await until(()=>notes.some(n=>n.method==="thread/settings/updated" && n.threadId===threadId && n.sandbox==="dangerFullAccess" && n.profile===undefined));
  const conflicting = new CodexBridgeController(config,store,bundles,fixtureClient());
  const conflictInput = {jobId,clientMessageId:"fixture-prestart-other",content:"Fixture conflict",
    executionMode:"workspace_write",approvalReviewer:"auto_review",dataClassification:"personal",model,effort:"high"};
  try {
    await conflicting.directMessage(conflictInput);
    await until(()=>store.get(jobId).status==="failed" && store.get(jobId).result?.message.includes("NATIVE_OTHER_WRITER"));
    assert.equal(store.get(jobId).turnId,undefined);
    assert.equal((await conflicting.directMessage(conflictInput)).delivery,"failed");
  } finally { await conflicting.close(); }
  assert.equal(requests.length,1);
  await send("after-quota","workspace_write","auto_review");
  await send("into-plan","plan","user");
  await send("out-of-plan","workspace_write","auto_review");
  await controller.releaseIdleSubscription(jobId,threadId);
  assert.deepEqual(releases,[{threadId,status:"unsubscribed"}]);
  const loadedAfterRelease = await loaded();
  await send("warm-rejoin","workspace_write","user");
  await controller.close(); client = fixtureClient(); controller = connect();
  assert.equal(await loaded(),false);
  assert.equal(await status(),"notLoaded");
  await send("cold-rejoin","workspace_write","auto_review");
  const normalRequestCount = requests.length;
  for (const action of ["compact","review"]) {
    const prior = store.get(jobId).turnId;
    const input = {jobId,expectedThreadId:threadId,expectedTurnId:prior,requestId:"fixture-action-"+action};
    const receipt = await controller.directThreadAction(action,input);
    assert.equal(receipt.delivery,"accepted");
    await until(()=>["completed","failed"].includes(store.get(jobId).status));
    const head = (await history()).data[0];
    assert.notEqual(head.id,prior);
    assert.equal(head.id,store.get(jobId).turnId);
    assert.equal(head.status,"completed", JSON.stringify(head.error));
    assert.equal((await controller.directThreadAction(action,input)).delivery,"duplicate");
    assert.equal(store.get(jobId).threadId,threadId);
    const verified = await rpc("thread/resume",{excludeTurns:true});
    assert.equal(verified.approvalPolicy,"on-request");
    assert.equal(verified.approvalsReviewer,"auto_review");
    assert.equal(verified.activePermissionProfile.id,action==="review"?"codex-bridge-read-only":":danger-full-access");
    assert.equal(verified.sandbox.type,action==="review"?"readOnly":"dangerFullAccess");
    assert.equal(verified.model,model); assert.equal(verified.reasoningEffort,"high");
    measurements.push({action,turnId:head.id,executionMode:action==="review"?"plan":"workspace_write",approvalReviewer:"auto_review"});
  }
  const sessions = join(home,"sessions");
  const rollouts = (await readdir(sessions,{recursive:true})).filter(p=>p.endsWith(".jsonl"));
  const contexts = [];
  for (const path of rollouts) {
    for (const row of (await readFile(join(sessions,path),"utf8")).trim().split("\n").map(JSON.parse)) {
      if (row.type!=="turn_context") continue;
      const p=row.payload;
      contexts.push({turnId:p.turn_id,rootTurnId:p.root_turn_id,model:p.model,effort:p.effort,
        policy:p.approval_policy,reviewer:p.approvals_reviewer,sandbox:p.sandbox_policy.type,profile:p.active_permission_profile?.id});
    }
  }
  for (const step of measurements) {
    const ctx=contexts.find(c=>step.action==="review" ? c.rootTurnId===step.turnId && c.turnId!==step.turnId : c.turnId===step.turnId);
    assert.equal(ctx?.model,model); assert.equal(ctx.effort,"high"); assert.equal(ctx.policy,step.action==="review"?"never":"on-request");
    assert.equal(ctx.reviewer,step.approvalReviewer);
    assert.equal(ctx.sandbox,step.executionMode==="plan"?"read-only":"danger-full-access");
    assert.equal(ctx.profile,step.executionMode==="plan"?"codex-bridge-read-only":":danger-full-access");
  }
  assert.equal(normalRequestCount,1+measurements.filter(m=>!m.action).length);
  assert.ok(requests.every(r=>r.model===model && r.effort==="high" && r.tier===null));
  // Independent real managed-profile transition. No Plan turn or host sandbox
  // setup in this synthetic home. Check both stages that protect the next turn.
  const managed = makeClient();
  const managedController = new CodexBridgeController(config,store,bundles,managed);
  let managedEvidence;
  try {
    const job = await managedController.dispatch({preview,previewDigest:preview.previewDigest,idempotencyKey:"managed-full-initial"});
    await until(()=>store.get(job.record.id).status==="completed");
    const threadId = store.get(job.record.id).threadId;
    const update = async (params) => {
      await managed.request("thread/settings/update",{threadId,...params,approvalPolicy:"on-request",approvalsReviewer:"user"});
      const reply=await managed.request("thread/resume",{threadId,excludeTurns:true});
      assert.equal(reply.thread.id,threadId);
      return {profile:reply.activePermissionProfile?.id ?? null,sandbox:reply.sandbox.type,network:reply.sandbox.networkAccess};
    };
    const plan = await update({permissions:"codex-bridge-read-only"});
    assert.equal(plan.sandbox,"readOnly");assert.equal(plan.network,true);
    const named = await update({permissions:":danger-full-access"});
    assert.equal(named.profile,":danger-full-access");assert.equal(named.sandbox,"workspaceWrite");
    await managedController.directMessage({jobId:job.record.id,clientMessageId:"managed-transition",content:"Continue fixture",
      executionMode:"workspace_write",approvalReviewer:"auto_review",dataClassification:"personal",model,effort:"high"});
    await until(()=>["completed","failed"].includes(store.get(job.record.id).status));
    assert.equal(store.get(job.record.id).status,"completed",store.get(job.record.id).result?.message);
    const verified=await managed.request("thread/resume",{threadId,excludeTurns:true});
    assert.equal(verified.activePermissionProfile.id,":danger-full-access");assert.equal(verified.sandbox.type,"dangerFullAccess");
    const audit=(await store.snapshot(job.record.id)).events.find(e=>e.type==="codex.resume.verification").data;
    assert.deepEqual(audit.stages.map(s=>s.stage),["resume","sandbox","profile"]);
    managedEvidence={threadId,plan,named,final:{profile:verified.activePermissionProfile.id,sandbox:verified.sandbox.type},audit};
  } finally { await managedController.close(); }
  const journal = (await readFile(join(config.jobsDir,jobId,"events.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
  const verification = journal.filter(e=>e.type==="codex.resume.verification").map(e=>e.data);
  console.log(JSON.stringify({version,verification,threadId,priorTurn,releases,loadedAfterRelease,managedEvidence,measurements,requests,contexts,notes},null,2));
} finally {
  gate?.();
  await controller.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
