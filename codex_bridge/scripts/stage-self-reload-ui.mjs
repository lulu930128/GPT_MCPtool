// Explicit source promotion inside an isolated release candidate only.
// Not part of the live checkout's build or package.json (both retain their Build ID).
import { copyFile, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.length !== 3 || process.argv[2] !== '--isolated-candidate' ||
    root.toLowerCase() === 'c:\\gpt_mcptool\\codex_bridge') {
  throw new Error('ISOLATED_CANDIDATE_REQUIRED');
}
const destination = await realpath(join(root, 'web'));
if (destination.toLowerCase() !== resolve(root, 'web').toLowerCase()) throw new Error('REPARSE_TARGET_REJECTED');
for (const path of [join(root, 'src', 'self-reload', 'ui.html'), join(destination, 'self-reload.html')]) {
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error('REPARSE_TARGET_REJECTED');
}
await copyFile(join(root, 'src', 'self-reload', 'ui.html'), join(destination, 'self-reload.html'));
console.log('Staged fail-closed R1 UI in isolated candidate.');
