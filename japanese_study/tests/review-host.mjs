// Isolated browser-test host. Never included in the production bundle.
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startJapaneseStudyHttpServer } from '../dist/src/http-server.js';

const hubBaseUrl = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(hubBaseUrl || '')) throw new Error('Provide an isolated loopback Hub.');
const adapter = await startJapaneseStudyHttpServer({ hubBaseUrl, hubTimeoutMs: 2000, host: '127.0.0.1', port: 0 });
const client = new Client({ name: 'isolated-review-browser-test', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(adapter.url)));
const open = await client.callTool({ name: 'study_open_review', arguments: {} });
if (open.isError) throw new Error(JSON.stringify(open.structuredContent));
const resource = (await client.readResource({ uri: 'ui://japanese-study/review-v1.html' })).contents[0].text;
let controls = {}, calls = [];
const host = createServer(async (req, res) => {
  try {
    if (req.url === '/app') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(resource); return; }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe id="app" src="/app" title="日文複習室" style="border:0;width:100%;height:900px"></iframe><script>' +
        'window.addEventListener("message",async e=>{const f=document.getElementById("app");if(e.source!==f.contentWindow)return;const m=e.data;if(!m.id)return;let result;' +
        'if(m.method==="ui/initialize")result={protocolVersion:"2026-01-26",hostInfo:{name:"test",version:"1"},hostCapabilities:{},hostContext:{theme:localStorage.theme||"light",availableDisplayModes:["inline","fullscreen"],displayMode:"inline"}};' +
        'else if(m.method==="ui/request-display-mode")result={mode:"fullscreen"};' +
        'else if(m.method==="tools/call")result=await fetch("/call",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(m.params)}).then(r=>r.json());' +
        'else return;f.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,result},location.origin);});</script></body></html>');
      return;
    }
    if (req.url === '/calls') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(calls)); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/control') { controls = body; res.end('{}'); return; }
    if (req.url !== '/call') { res.writeHead(404); res.end('{}'); return; }
    const metric = { ...body, responseBytes: 0, status: 'pending' };
    calls.push(metric);
    const started = performance.now();
    const send = result => {
      const json = JSON.stringify(result);
      Object.assign(metric, { responseBytes: Buffer.byteLength(json), ms: performance.now() - started,
        status: result.isError ? 'error' : 'ok' });
      res.end(json);
    };
    if (body.name === 'study_search_items' && body.arguments.query === '遅い')
      await new Promise(resolve => setTimeout(resolve, 800));
    if (controls.failReadback && body.name === 'study_read_review_workspace' && body.arguments.scope === 'deck') {
      controls.failReadback = false;
      send({ isError: true, structuredContent: { ok: false, error: { code: 'HUB_UNAVAILABLE', message: 'injected read failure' } } });
      return;
    }
    const result = await client.callTool(body);
    if (controls.loseAttemptReply && body.name === 'study_update_review_workspace' && body.arguments.change.action === 'move') {
      controls.loseAttemptReply = false;
      send({ isError: true, structuredContent: { ok: false, error: { code: 'TRANSPORT_TIMEOUT', message: 'injected lost acknowledgement' } } });
      return;
    }
    if (controls.loseLabelReply && body.name === 'study_set_manual_labels') {
      controls.loseLabelReply = false;
      send({ isError: true, structuredContent: { ok: false, error: { code: 'TRANSPORT_TIMEOUT', message: 'injected lost acknowledgement' } } });
      return;
    }
    send(result);
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isError: true, structuredContent: { ok: false, error: { code: 'TEST_HOST_FAILURE', message: 'Test host failed' } } }));
  }
});
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + host.address().port }) + '\n');
const close = async () => { await client.close(); await adapter.close(); host.close(); };
process.on('SIGTERM', close);
process.on('SIGINT', close);
