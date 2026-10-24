// Synthetic browser host. No Bridge, App Server, lifecycle, Windows pipe or credential is contacted.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const widget=await readFile(new URL("../web/self-reload.html",import.meta.url),"utf8");
const child=createServer((_,res)=>{res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(widget);});
await new Promise(resolve=>child.listen(0,"127.0.0.1",resolve));
const childUrl=`http://127.0.0.1:${child.address().port}`;
const host=createServer((_,res)=>{
  res.writeHead(200,{"content-type":"text/html; charset=utf-8","permissions-policy":"publickey-credentials-get=(), publickey-credentials-create=()"});
  res.end(`<!doctype html><meta charset="utf-8"><title>R1 synthetic host</title><style>body{background:#202a36;color:#fff;font:16px sans-serif}iframe{width:min(760px,95vw);height:920px;border:0}</style><p>SYNTHETIC ONLY — host denies WebAuthn</p><iframe src="${childUrl}"></iframe><script>
    let receipt=null;const iframe=document.querySelector('iframe');
    window.addEventListener('message',event=>{if(event.source!==iframe.contentWindow||event.origin!==${JSON.stringify(childUrl)})return;
      const m=event.data;if(!m.id)return;let result={};
      if(m.method==='tools/call'){
        const op=m.params.name.replace('codex_self_reload_','');
        let data=op==='status'?{deployment:'DEPLOYED'}:op==='preview'?{previewDigest:'b'.repeat(64),oldPid:8101,oldBuildId:'1'.repeat(16),targetBuildId:'2'.repeat(16)}:receipt;
        if(op==='request'){receipt={requestId:'11111111-1111-4111-8111-111111111111',digest:'a'.repeat(64),oldPid:8101,oldBuildId:'1'.repeat(16),targetBuildId:'2'.repeat(16),expiresAt:new Date(Date.now()+900000).toISOString(),state:'accepted',code:'HUMAN_APPROVAL_REQUIRED',history:[{state:'accepted'}]};data=receipt;}
        if(op==='approve'||op==='challenge')throw new Error('Host gate must prevent approval');result={structuredContent:data};
      }
      event.source.postMessage({jsonrpc:'2.0',id:m.id,result},event.origin);
    });</script>`);
});
await new Promise(resolve=>host.listen(0,"127.0.0.1",resolve));
console.log(JSON.stringify({synthetic:true,url:`http://127.0.0.1:${host.address().port}`,childUrl}));
process.on("SIGTERM",()=>{host.close();child.close();});
