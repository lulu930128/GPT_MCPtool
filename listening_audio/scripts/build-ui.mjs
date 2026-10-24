import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const result = await build({ entryPoints: [fileURLToPath(new URL('ui/question-download.js', root))],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
const template = await readFile(new URL('ui/question-download.html', root), 'utf8');
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace('<!-- APP_SCRIPT -->', () => `<script>${script}</script>`);
await mkdir(new URL('dist/ui/', root), { recursive: true });
await writeFile(new URL('dist/ui/question-download.html', root), html);
console.log(`Built download UI: ${Buffer.byteLength(html)} bytes`);
