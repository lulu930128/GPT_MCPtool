import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createComponentUpdates } from '../../project_reading/dist/src/component-update.js';
const wire = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const result = await createComponentUpdates(async () => wire, true)
  .mcp_component_update_receipt({ requestId: wire.requestId });
assert.equal(result.code, 'RECEIPT_OBSERVED');
assert.equal(result.receipt.phase, 'REJECTED');
assert.equal(result.receipt.code, 'DAILY_NO_CODE_CHANGE');
for (const field of ['terminal', 'completed', 'finished']) assert.equal(result[field], true, field);
assert.equal(result.succeeded, false);
assert.equal(result.requiresRecovery, false);
assert.equal(result.receipt.preparedBuildId, null);
assert.deepEqual(result.receipt, wire.receipt);
console.log('PASS Workspace projection of real Native/canonical no-change receipt: 10 checks');
