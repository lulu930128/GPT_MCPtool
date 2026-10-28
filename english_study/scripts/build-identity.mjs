import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const distRoot = process.argv[2];
if (process.argv.length !== 3 || !distRoot || !isAbsolute(distRoot)) throw new Error('BUILD_IDENTITY_ROOT_REQUIRED');
const http = await import(pathToFileURL(resolve(distRoot, 'src/http-server.js')).href);
const server = await import(pathToFileURL(resolve(distRoot, 'src/server.js')).href);
console.log(JSON.stringify({ version: server.ENGLISH_STUDY_MCP_VERSION, buildId: http.computeBuildId(), contractVersion: server.ENGLISH_STUDY_CONTRACT_VERSION, toolCount: server.ENGLISH_STUDY_TOOL_COUNT }));
