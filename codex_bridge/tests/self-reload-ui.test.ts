import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { webcrypto } from "node:crypto";

// Test the source candidate without changing the live web asset / canonical Build ID.
const html=readFileSync(new URL("../../src/self-reload/ui.html",import.meta.url),"utf8");
const script=html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const candidateScript=readFileSync(new URL("../../src/self-reload/ui.html",import.meta.url),"utf8").match(/<script>([\s\S]*?)<\/script>/)![1]!;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(receiptState="completed",policyAllowed=false,storage=new Map<string,string>(),candidate=false,policyMode="present"){
  const elements=new Map<string,any>();
  const element=(id:string)=>{if(!elements.has(id))elements.set(id,{textContent:"",value:"",hidden:false,disabled:false,checked:false,children:[],append(...nodes:any[]){this.children.push(...nodes);},replaceChildren(){this.children=[];}});return elements.get(id);};
  let listener!:(event:any)=>void;const calls:any[]=[];let assertions=0;
  const receipt={requestId:"11111111-1111-4111-8111-111111111111",digest:"a".repeat(64),state:receiptState,code:"FIXTURE",expiresAt:new Date(Date.now()+60000).toISOString(),history:[{state:receiptState}],oldPid:12,oldBuildId:"1".repeat(16),targetBuildId:"2".repeat(16)};
  const parent={postMessage(message:any){queueMicrotask(()=>{
    let result:any={};
    if(message.method==="tools/call"){
      const op=message.params.name.replace("codex_self_reload_","");calls.push({op,args:message.params.arguments});
      const data=op==="status"?{deployment:"DEPLOYED"}:op==="preview"?{previewDigest:"b".repeat(64),...receipt}:op==="challenge"?{receipt,publicKey:{challenge:"YQ",credentialId:"YQ",rpId:"reload.example.test"}}:receipt;
      result={structuredContent:data};
    }
    if(message.id)listener({source:parent,origin:"https://chatgpt.com",data:{jsonrpc:"2.0",id:message.id,result}});
  });}};
  const context:any={document:{getElementById:element,createElement:()=>({textContent:""}),permissionsPolicy:{allowsFeature:()=>policyAllowed}},
    window:{parent,isSecureContext:true,PublicKeyCredential:{},addEventListener:(_:string,fn:any)=>listener=fn},
    localStorage:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value)},
    navigator:{credentials:{create:async()=>{assertions++;throw new Error("Unexpected credential creation");},get:async()=>{assertions++;return {rawId:new Uint8Array([1]),response:{clientDataJSON:new Uint8Array([1]),authenticatorData:new Uint8Array([1]),signature:new Uint8Array([1])}};}},clipboard:{writeText:async()=>{}}},
    location:{hostname:"reload.example.test",origin:"https://reload.example.test"},crypto:webcrypto,Uint8Array,atob,btoa,Date,Map,Set,JSON,Error,
    setTimeout:(fn:any,ms:number)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout};
  if(policyMode==="missing")delete context.document.permissionsPolicy;
  if(policyMode==="throws")context.document.permissionsPolicy.allowsFeature=()=>{throw new Error("unsupported policy");};
  new Script(candidate?candidateScript:script).runInNewContext(context);await flush();await flush();
  return {elements,element,calls,receipt,storage,assertions:()=>assertions,click:async(id:string)=>{element(id).onclick();await flush();await flush();}};
}

test("R1 candidate reports actual policy observations without treating allowed host as verified",async()=>{
  for(const allowed of [false,true])for(const mode of ["present","missing","throws"]){
    const ui=await fixture("accepted",allowed,new Map(),true,mode);
    const diagnostic=JSON.parse(ui.element("host-diagnostics").textContent);
    assert.equal(diagnostic.status,"HOST_NOT_VERIFIED");
    assert.equal(diagnostic.permissionsPolicyGet,allowed&&mode==="present");
    assert.equal(diagnostic.permissionsPolicyCreate,allowed&&mode==="present");
    assert.equal(diagnostic.realCeremony,"UNVERIFIED");
    await ui.click("check-host");await ui.click("preview");await ui.click("request");
    ui.element("receipt-id").value=ui.receipt.requestId;await ui.click("query");
    ui.element("exact").checked=true;ui.element("exact").onchange();
    await ui.click("approve");await ui.click("enroll");
    assert.equal(ui.assertions(),0);
    assert.equal(ui.calls.some(x=>["request","challenge","approve"].includes(x.op)),false);
    assert.equal(ui.element("request").disabled,true);assert.equal(ui.element("approve").disabled,true);
    assert.match(ui.element("notice").textContent,/HOST_NOT_VERIFIED/);
  }
});
test("R1 UI host permissions policy blocks WebAuthn even when API exists",async()=>{
  const ui=await fixture("accepted",false);ui.element("receipt-id").value=ui.receipt.requestId;await ui.click("query");
  ui.element("exact").checked=true;ui.element("exact").onchange();await ui.click("approve");
  assert.equal(ui.assertions(),0);assert.match(ui.element("notice").textContent,/HOST_NOT_VERIFIED/);
  assert.equal(ui.calls.some(x=>x.op==="approve"||x.op==="challenge"),false);
});
test("R1 UI checkbox and allowed policy cannot substitute for real host verification",async()=>{
  const ui=await fixture("accepted",true);ui.element("receipt-id").value=ui.receipt.requestId;await ui.click("query");await ui.click("approve");assert.equal(ui.assertions(),0);
  ui.element("exact").checked=true;ui.element("exact").onchange();await ui.click("approve");assert.equal(ui.assertions(),0);
  assert.equal(ui.calls.some(x=>x.op==="approve"||x.op==="challenge"),false);
});
test("R1 UI restores receipt after iframe restart and starts a new key only after freshly verified safe terminal",async()=>{
  for(const state of ["completed","failed","accepted","approved","dispatching","running","unknown"]){
    const storage=new Map([["codex-self-reload-r1",JSON.stringify({idempotencyKey:"old-key",requestId:"11111111-1111-4111-8111-111111111111"})]]);
    const first=await fixture(state,false,storage);assert.equal(first.element("receipt-id").value,first.receipt.requestId);
    await first.click("query");await first.click("new-request");
    const saved=JSON.parse(storage.get("codex-self-reload-r1")!);
    if(["completed","failed"].includes(state)){assert.equal(saved,null);await first.click("preview");await first.click("request");assert.equal(first.calls.some(x=>x.op==="request"),false);}
    else {assert.equal(saved.requestId,first.receipt.requestId);assert.equal(first.calls.some(x=>x.op==="request"),false);}
    const reloaded=await fixture(state,false,storage);assert.equal(reloaded.element("receipt-id").value,["completed","failed"].includes(state)?"":first.receipt.requestId);
  }
});
