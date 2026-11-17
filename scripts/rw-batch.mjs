#!/usr/bin/env node
// The batch commands of a standing Router/Worker team (ADR 0010, decisions 8 to 12).
// before BATCH.json --instance <instance-root> [--start-as-is]
//   Checks and freezes the tickets, checks the product repository, computes the ceiling, takes the lock and
//   opens the write boundary. Prints the batch record; its `args` are the arguments of run-n-rounds.
// BATCH.json: {"tickets": [{"id", "title", "goal", "acceptance": [...], "paths": [...], "estimate": {"execTokens", "checkTokens", "reworkTokens"}}],
//              "verificationCommands": [...], "sensitivePaths": [...], "nextLifecycleNumber": n, "runId"?, "date"?}
// abort --instance <instance-root>
//   Clears a batch that will not be run, or what a "before" that died left behind.
// after RESULT.json --instance <instance-root>
//   RESULT.json is the engine's return. Matches it against the frozen batch, compares the product with the
//   tickets' paths, closes the write boundary, releases the lock and plans the commits. Exit 2 when in review.
// commit --instance <instance-root>
//   One commit per ticket that passed, on the batch's branch, then archives the batch under batches/<run id>/.
// No model or network. Exit 0 done and clean, 2 refused or in review, 1 usage.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeBatch, abortBatch } from '../src/router-worker/batch.mjs';
import { afterBatch, commitBatch } from '../src/router-worker/batch-close.mjs';

const print = result => { if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; } else process.stdout.write(JSON.stringify(result, null, 2) + '\n'); };
const USAGE = 'usage: node scripts/rw-batch.mjs before BATCH.json --instance <instance-root> [--start-as-is]\n       node scripts/rw-batch.mjs after RESULT.json --instance <instance-root>\n       node scripts/rw-batch.mjs commit --instance <instance-root>\n       node scripts/rw-batch.mjs abort --instance <instance-root>';
if (['abort', 'commit'].includes(process.argv[2])) {
  const [flag, root, ...extra] = process.argv.slice(3);
  if (flag !== '--instance' || !root || extra.length) { console.error(USAGE); process.exit(1); }
  print((process.argv[2] === 'abort' ? abortBatch : commitBatch)({ teamRoot: join(resolve(root), 'kit'), instanceRoot: resolve(root) }));
  process.exit();
}
if (process.argv[2] === 'after') {
  const [resultFile, flag, root, ...extra] = process.argv.slice(3);
  if (!resultFile || flag !== '--instance' || !root || extra.length) { console.error(USAGE); process.exit(1); }
  let result; try { result = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { result = undefined; }
  const closed = afterBatch({ teamRoot: join(resolve(root), 'kit'), instanceRoot: resolve(root), result });
  print(closed);
  if (!closed.errors && closed.status !== 'clean') process.exitCode = 2;
  process.exit();
}
const [command, file, ...rest] = process.argv.slice(2), at = rest.indexOf('--instance'), instance = at === -1 ? undefined : rest[at + 1];
const others = rest.filter((_, i) => i !== at && i !== at + 1);
if (command !== 'before' || !file || !instance || others.some(flag => flag !== '--start-as-is') || others.length > 1) { console.error(USAGE); process.exit(1); }
// The engine's static launch preflight, run on the frozen arguments; its digest goes into them.
function manifest(args, { teamRoot, productRoot, allowDirty }) {
  const dir = mkdtempSync(join(tmpdir(), 'rw-batch-manifest-'));
  try {
    const argsFile = join(dir, 'args.json'); writeFileSync(argsFile, JSON.stringify(args));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./preflight-run.mjs', import.meta.url)), argsFile, '--team-root', teamRoot, '--product-root', productRoot, ...(allowDirty ? ['--allow-dirty-product'] : [])], { encoding: 'utf8' });
    let found; try { found = JSON.parse(run.stdout).launchManifestDigest; } catch { found = null; }
    if (run.status === 0 && /^sha256:[a-f0-9]{64}$/.test(found ?? '')) return { digest: found };
    const failures = (run.stderr ?? '').split('\n').filter(line => line.startsWith('FAIL - ')).map(line => line.slice(0, 200)).join('; ');
    return { errors: [{ code: 'PREFLIGHT_FAILED', field: 'batch', reason: `The launch preflight did not pass: ${failures || 'no manifest produced'}` }] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
let batch; try { batch = JSON.parse(readFileSync(file, 'utf8')); } catch { batch = undefined; }
const instanceRoot = resolve(instance);
const result = batch === undefined ? { errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: `${file} is not readable JSON` }] }
  : await beforeBatch({ teamRoot: join(instanceRoot, 'kit'), instanceRoot, batch, startAsIs: others.includes('--start-as-is'), manifest });
print(result);
