import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

// B2-0 only: immutable synthetic tone, no filesystem or workspace access.
export function createProbeWav(): Buffer {
  const rate = 16000, samples = rate * 3;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 800, (samples - 1 - i) / 800);
    bytes.writeInt16LE(Math.round(1800 * fade * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  }
  return bytes;
}

export function validateProbeOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("A public HTTPS origin is required; a tunnel ID is not a URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    throw new Error("Configure an exact public HTTPS origin without credentials, path, query or fragment.");
  }
  return url.origin;
}

export function parseProbeRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ([first,last].some(value => value !== undefined && !Number.isSafeInteger(value))) return null;
  if (first === undefined) return last && last > 0 ? {start:Math.max(0,size-last),end:size-1} : null;
  if (first >= size || (last !== undefined && last < first)) return null;
  return {start:first,end:Math.min(last ?? size-1,size-1)};
}

export async function startAudioHttpsProbe(options: { publicOrigin: string; port?: number; ttlSeconds?: number; now?: () => number }) {
  const origin = validateProbeOrigin(options.publicOrigin);
  const ttl = options.ttlSeconds ?? 120;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300) throw new Error("Probe TTL must be 1-300 seconds.");
  const now = options.now ?? Date.now;
  const bytes = createProbeWav();
  const grants = new Map<string, number>();
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const counters = { requests:0, full:0, range:0, denied:0 };
  let closed = false;
  function cleanup() { for (const [key,expiry] of grants) if (expiry <= now()) grants.delete(key); }
  const server = createServer((req,res) => {
    // Match the raw path: no Host header trust, query parameters or redirects.
    const match = /^\/media\/audio\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? "");
    res.setHeader("Cache-Control","private, no-store");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    if (!match) { res.writeHead(404); res.end(); return; }
    counters.requests++;
    const expiry = grants.get(hash(match[1]));
    cleanup();
    if (!expiry || expiry <= now()) { counters.denied++; res.writeHead(404); res.end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("Allow","GET, HEAD"); res.writeHead(405); res.end(); return; }
    // HEAD ignores Range, matching GET headers without transferring a body.
    const range = parseProbeRange(req.method === "HEAD" ? undefined : req.headers.range,bytes.length);
    res.setHeader("Accept-Ranges","bytes");
    if (!range) { res.setHeader("Content-Range",`bytes */${bytes.length}`); res.writeHead(416); res.end(); return; }
    const partial = req.method === "GET" && !!req.headers.range;
    if (partial) { counters.range++; res.setHeader("Content-Range",`bytes ${range.start}-${range.end}/${bytes.length}`); }
    else counters.full++;
    res.setHeader("Content-Type","audio/wav");
    res.setHeader("Content-Length",range.end-range.start+1);
    res.writeHead(partial ? 206 : 200);
    res.end(req.method === "HEAD" ? undefined : bytes.subarray(range.start,range.end+1));
  });
  server.maxConnections = 8;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(options.port ?? 0,"127.0.0.1",() => {server.off("error",reject);resolve();}); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe listener unavailable.");
  return {
    port:address.port,
    issue() {
      if (closed) throw new Error("Probe is closed.");
      cleanup();
      if (grants.size >= 16) throw new Error("Probe grant capacity reached.");
      const token = randomBytes(32).toString("base64url"), expiresAt = now() + ttl*1000;
      grants.set(hash(token),expiresAt);
      return {ok:true,transport:"https_probe",filename:"synthetic-440hz-3s.wav",mimeType:"audio/wav",bytes:bytes.length,
        sha256:createHash("sha256").update(bytes).digest("hex"),audioUrl:`${origin}/media/audio/${token}`,expiresAt};
    },
    counters,
    async close() { closed = true; grants.clear(); server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
