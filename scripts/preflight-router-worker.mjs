import { readFileSync, statSync } from 'node:fs';
import { parseJSON } from '../src/loop/contracts.mjs';
import { preflight } from '../src/router-worker/preflight.mjs';

const [inputPath, teamRoot, approvalPath, expectedApprovalDigest, ...extra] = process.argv.slice(2);
if (!expectedApprovalDigest || extra.length) {
  console.error('usage: node scripts/preflight-router-worker.mjs <input.json> <team-root> <approval-relative-path> <reviewed-approval-sha256>');
  process.exitCode = 1;
} else {
  try {
    const stat = statSync(inputPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Invalid input file');
    const input = parseJSON(readFileSync(inputPath, 'utf8'));
    const result = preflight({ input, teamRoot, approvalPath, expectedApprovalDigest });
    if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
    else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch {
    console.error(JSON.stringify({ errors: [{ code: 'INVALID_INPUT', field: 'input', reason: 'Expected a readable bounded JSON input file' }] }));
    process.exitCode = 2;
  }
}
