import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = resolve(root, process.argv[2] || "dist", "src/ui");
await mkdir(target, { recursive: true });
for (const name of ["review.html", "review.css", "bridge.js", "review.js"]) {
  await cp(resolve(root, "src/ui", name), resolve(target, name));
}
