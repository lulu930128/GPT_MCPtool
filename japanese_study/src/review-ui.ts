import { readFileSync } from "node:fs";

export const REVIEW_RESOURCE_URI = "ui://japanese-study/review-v1.html";
export const REVIEW_MIME_TYPE = "text/html;profile=mcp-app";

export function loadReviewUi(): string {
  const read = (name: string) => readFileSync(new URL(`./ui/${name}`, import.meta.url), "utf8");
  const script = [read("bridge.js"), read("review.js")].join("\n").replace(/<\/script/gi, "<\\/script");
  return read("review.html")
    .replace("<!--STUDY_CSS-->", () => `<style>${read("review.css")}</style>`)
    .replace("<!--STUDY_JS-->", () => `<script>${script}</script>`);
}
