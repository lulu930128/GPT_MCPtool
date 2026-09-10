import test from "node:test";
import assert from "node:assert/strict";
import {createProbeWav,parseProbeRange,startAudioHttpsProbe,validateProbeOrigin} from "../src/audio-https-probe.js";

test("HTTPS probe validates origin and single byte ranges",() => {
  for (const value of ["tunnel_id","http://example.invalid","https://localhost","https://127.0.0.1","https://a.invalid/path","https://u:p@a.invalid","https://a.invalid/?token=x"]) assert.throws(() => validateProbeOrigin(value));
  assert.deepEqual(parseProbeRange("bytes=-100",1000),{start:900,end:999});
  assert.deepEqual(parseProbeRange("bytes=900-",1000),{start:900,end:999});
  assert.deepEqual(parseProbeRange("bytes=0-9999",1000),{start:0,end:999});
  for (const value of ["bytes=500-100","bytes=0-1,2-3","bytes=-0","bytes=1000-","bytes=99999999999999999999-","bytes=-"]) assert.equal(parseProbeRange(value,1000),null);
});

test("synthetic probe isolates routes, validates grants, supports HTTP and expires",async t => {
  let now = 1000;
  const probe = await startAudioHttpsProbe({publicOrigin:"https://example.invalid",now:() => now});
  t.after(() => probe.close());
  const grant = probe.issue();
  const base = `http://127.0.0.1:${probe.port}`;
  const route = new URL(grant.audioUrl).pathname;
  const full = await fetch(base+route);
  assert.equal(full.status,200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),createProbeWav());
  assert.equal(full.headers.get("cache-control"),"private, no-store");
  const part = await fetch(base+route,{headers:{Range:"bytes=0-99"}});
  assert.equal(part.status,206); assert.equal((await part.arrayBuffer()).byteLength,100);
  assert.equal(part.headers.get("content-range"),"bytes 0-99/96044");
  assert.equal((await fetch(base+route,{method:"HEAD"})).headers.get("content-length"),"96044");
  assert.equal((await fetch(base+route,{headers:{Range:"bytes=0-1,3-4"}})).status,416);
  for (const path of ["/mcp","/health","/media/audio/unknown",route+"?path=secret"]) assert.equal((await fetch(base+path)).status,404);
  for(let i=1;i<16;i++) probe.issue();
  assert.throws(() => probe.issue(),/capacity/);
  now += 120000;
  assert.equal((await fetch(base+route)).status,404);
  assert.ok(probe.issue());
});
