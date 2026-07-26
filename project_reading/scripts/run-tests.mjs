import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const testsDir = path.resolve("dist", "tests");
const entries = await fs.readdir(testsDir);
const tests = entries
  .filter((entry) => entry.endsWith(".test.js"))
  .sort((left, right) => left.localeCompare(right));

if (tests.length === 0) {
  throw new Error(`No compiled test files found in ${testsDir}`);
}

for (const test of tests) {
  await import(pathToFileURL(path.join(testsDir, test)).href);
}
