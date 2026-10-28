import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
const root = new URL('../', import.meta.url);
const requestedDist = process.argv[2];
if (process.argv.length > 3 || (requestedDist && !isAbsolute(requestedDist))) throw new Error('BUILD_OUTPUT_ABSOLUTE_PATH_REQUIRED');
const outputRoot = requestedDist ? resolve(requestedDist, 'ui') : fileURLToPath(new URL('dist/ui/', root));
const result = await build({ entryPoints: [fileURLToPath(new URL('ui/question-download.js', root))],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
const template = await readFile(new URL('ui/question-download.html', root), 'utf8');
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace('<!-- APP_SCRIPT -->', () => `<script>${script}</script>`);
await mkdir(outputRoot, { recursive: true });
await writeFile(resolve(outputRoot, 'question-download.html'), html);
console.log(`Built download UI: ${Buffer.byteLength(html)} bytes`);
