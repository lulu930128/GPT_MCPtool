import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalReview, ReviewBinding } from "./broker.js";
import { ApprovalError, type Receipt } from "./contract.js";

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
export function reviewHtml(receipt: Receipt, binding: ReviewBinding): string {
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>本機逐筆審核</title>
<h1>${receipt.request.executionMode === "ADMIN" ? "ADMIN / Elevated — 尚待本機 UAC" : "NORMAL / 普通使用者"}</h1>
<p>OFFLINE ONLY：尚未取得正式主機授權。密碼僅在本機介面輸入。核准不代表已執行。</p>
<p>請核對完整操作、目標、副作用、Digest 與到期時間；拒絕或 UNKNOWN 不會重送。</p>
<pre>${escape(JSON.stringify(receipt, null, 2))}</pre>
<form method="post" action="/decision" autocomplete="off">
<input type="hidden" name="challenge" value="${escape(binding.challenge)}">
<label>本機確認密碼 <input name="password" type="password" autocomplete="off" maxlength="256"></label>
<button name="decision" value="approve"${receipt.request.executionMode === "ADMIN" ? " disabled" : ""}>僅核准這一筆</button>
<button name="decision" value="deny">拒絕</button></form></html>`;
}

/** Offline HTTP handler ONLY, no listener/production route. Dedicated local session is provisioned
 * by the test host, never Bridge bearer/MCP visibility. No secret is returned, logged or persisted.
 * A real protected desktop host/session and OS secret store are still NOT implemented. */
export function offlineLocalReviewHandler(options: {
  origin: string; session: Buffer; requestId: string; review: LocalReview;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(options.origin) || options.session.length !== 32) throw new ApprovalError("LOCAL_UI_CONFIGURATION_REJECTED");
  const host = new URL(options.origin).host;
  const session = Buffer.from(options.session.toString("hex"), "ascii");
  let binding: ReviewBinding | undefined;
  let busy = false;
  return async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const deny = (status: number) => { res.statusCode = status; res.end("LOCAL_REVIEW_REJECTED"); };
    const cookie = /^local_review=([a-f0-9]{64})$/.exec(req.headers.cookie ?? "");
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== host
      || (req.headers.origin && req.headers.origin !== options.origin)
      || !cookie || !timingSafeEqual(Buffer.from(cookie[1], "ascii"), session)
      || (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) return deny(403);
    if (busy) return deny(409);
    busy = true;
    let body: Buffer | undefined;
    let secret: Buffer | undefined;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    try {
      if (req.method === "GET" && req.url === "/review") {
        if (binding) return deny(409);
        const review = await options.review.open(options.requestId);
        binding = review.binding;
        res.end(reviewHtml(review.receipt, binding));
        return;
      }
      if (req.method !== "POST" || req.url !== "/decision") return deny(404);
      if (!binding || req.headers.origin !== options.origin
        || req.headers["content-type"] !== "application/x-www-form-urlencoded"
        || req.headers["transfer-encoding"] || !/^\d{1,4}$/.test(req.headers["content-length"] ?? "")
        || Number(req.headers["content-length"]) > 2048) return deny(403);
      req.setTimeout(5000, () => req.destroy());
      bodyTimer = setTimeout(() => req.destroy(), 5000); // Absolute bound, including a trickling body.
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) { for (const part of chunks) part.fill(0); return deny(413); }
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      const form = new URLSearchParams(body.toString("utf8"));
      if ([...form.keys()].sort().join(",") !== "challenge,decision,password"
        || form.get("challenge") !== binding.challenge || !["approve", "deny"].includes(form.get("decision") ?? "")) return deny(403);
      secret = Buffer.from(form.get("password") ?? "", "utf8");
      form.delete("password");
      const receipt = await options.review.decide(binding, form.get("decision") as "approve" | "deny", secret);
      binding = undefined;
      res.end(`<p>${escape(receipt.state)}</p><p>Receipt: ${escape(receipt.request.receiptId)}</p>`);
    } catch { deny(409); }
    finally { if (bodyTimer) clearTimeout(bodyTimer); req.setTimeout(0); for (const chunk of chunks) chunk.fill(0); body?.fill(0); secret?.fill(0); busy = false; }
  };
}
