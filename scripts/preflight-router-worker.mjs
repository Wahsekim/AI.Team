import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJSON } from '../src/loop/contracts.mjs';
import { preflight } from '../src/router-worker/preflight.mjs';

const argv = process.argv.slice(2), flag = argv.indexOf('--instance');
const instance = flag === -1 ? [] : argv.splice(flag, 2).slice(1);
const [inputPath, teamRoot, approvalPath, expectedApprovalDigest, ...extra] = argv;
if (!expectedApprovalDigest || extra.length || (flag !== -1 && !instance[0])) {
  console.error('usage: node scripts/preflight-router-worker.mjs <input.json> <team-root> <approval-relative-path> <reviewed-approval-sha256> [--instance <instance-root>] (with --instance, <team-root> is <instance-root>/kit)');
  process.exitCode = 1;
} else {
  try {
    const stat = statSync(inputPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Invalid input file');
    const input = parseJSON(readFileSync(inputPath, 'utf8'));
    const result = preflight({ input, teamRoot, approvalPath, expectedApprovalDigest, ...(instance[0] ? { instanceRoot: resolve(instance[0]) } : {}) });
    if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
    else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch {
    console.error(JSON.stringify({ errors: [{ code: 'INVALID_INPUT', field: 'input', reason: 'Expected a readable bounded JSON input file' }] }));
    process.exitCode = 2;
  }
}
