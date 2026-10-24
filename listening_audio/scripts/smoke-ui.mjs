// Real browser + official AppBridge test host. Does NOT claim ChatGPT support.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { downloadHtml } from '../dist/src/download-app.js';
import { wav } from '../dist/tests/fixtures.js';
const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_PACKAGE ? require(process.env.PLAYWRIGHT_PACKAGE) : require('playwright');
const host = `import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const params = new URLSearchParams(location.search);
const frame = document.querySelector('iframe');
const bridge = new AppBridge(null, {name:'local-download-test-host',version:'1'}, params.has('unsupported') ? {} : {downloadFile:{}});
window.requests = [];
bridge.ondownloadfile = async ({contents}) => {
  window.requests.push(contents);
  if (params.has('denied')) return {isError:true};
  if (params.has('error')) throw new Error('Test failure');
  const response = await fetch('/test-resource?uri=' + encodeURIComponent(contents[0].uri));
  if (!response.ok) return {isError:true};
  const blob = await response.blob(), link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = contents[0].name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  return {};
};
const initial = {ok:true,setId:'exam001',questionId:'Q001',audio:{state:'ready',bytes:76,resourceUri:'listening-audio://sets/exam001/Q001.wav',mimeType:'audio/wav',filename:'Q001.wav'}};
window.showResult = data => bridge.sendToolResult({structuredContent:data,content:[]});
bridge.oninitialized = () => window.showResult(initial);
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = '/widget';`;
const bundle = await build({ stdin: { contents: host, resolveDir: process.cwd() }, bundle:true, write:false, format:'esm', platform:'browser' });
const server = createServer((req,res) => {
  if (req.url === '/widget') { res.setHeader('Content-Type','text/html'); res.end(downloadHtml()); }
  else if (req.url === '/host.js') { res.setHeader('Content-Type','text/javascript'); res.end(bundle.outputFiles[0].text); }
  else if (req.url?.startsWith('/test-resource')) {
    if (new URL(req.url,'http://local').searchParams.get('uri') !== 'listening-audio://sets/exam001/Q001.wav') {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','audio/wav');res.end(wav());
  } else { res.setHeader('Content-Type','text/html');res.end('<iframe sandbox="allow-scripts" style="border:0;width:100%;height:360px"></iframe><script type="module" src="/host.js"></script>'); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless:true });
const output = resolve('.tmp/download-ui'); await mkdir(output,{recursive:true});
try {
  const page = await browser.newPage({acceptDownloads:true,viewport:{width:500,height:450}});
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const scenario of ['supported','unsupported','denied','error']) {
    await page.goto(base + '/?' + scenario);
    const frame = page.frameLocator('iframe'), button = frame.locator('#download');
    await frame.locator('#diagnostics').filter({hasText:'"connected": true'}).waitFor({state:'attached'});
    if (scenario === 'unsupported') {
      assert.equal(await button.isDisabled(),true);
      assert.match(await frame.locator('#status').textContent(),/不支援/);
    } else {
      await button.waitFor();
      if (scenario === 'supported') {
        const next = page.waitForEvent('download'); await button.click(); const download = await next;
        assert.equal(download.suggestedFilename(),'Q001.wav');
        const path=resolve(output,'Q001.wav'); await download.saveAs(path);
        assert.deepEqual(await readFile(path),wav());
        await frame.locator('#status').filter({hasText:'已接受'}).waitFor();
        await page.screenshot({path:resolve(output,'supported.png')});
        await page.evaluate(() => window.showResult({ok:true,setId:'exam001',questionId:'Q002',audio:{state:'stale',bytes:0}}));
        await frame.locator('#status').filter({hasText:'尚未準備'}).waitFor();
        assert.equal(await button.isDisabled(),true);
        assert.equal(await page.evaluate(() => window.requests.length),1);
      } else {
        await button.click();
        await frame.locator('#status').filter({hasText:scenario === 'denied' ? '未完成' : '失敗'}).waitFor();
        assert.equal(await button.isDisabled(),false);
      }
    }
    console.log('PASS browser:',scenario);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
