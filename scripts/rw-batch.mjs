#!/usr/bin/env node
// The batch commands of a standing Router/Worker team (ADR 0010, decisions 8 to 12).
// before BATCH.json --instance <instance-root> [--start-as-is]
//   Checks and freezes the tickets, checks the product repository, computes the ceiling, takes the lock and
//   opens the write boundary. Prints the batch record; its `args` are the arguments of run-n-rounds.
// BATCH.json: {"tickets": [{"id", "title", "goal", "acceptance": [...], "paths": [...], "estimate": {"execTokens", "checkTokens", "reworkTokens"}}],
//              "verificationCommands": [...], "sensitivePaths": [...], "nextLifecycleNumber": n, "runId"?, "date"?}
// abort --instance <instance-root>
//   Clears a batch that will not be run, or what a "before" that died left behind.
// No model or network. Exit 0 batch open / aborted, 2 refused, 1 usage.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeBatch, abortBatch } from '../src/router-worker/batch.mjs';

const print = result => { if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; } else process.stdout.write(JSON.stringify(result, null, 2) + '\n'); };
const USAGE = 'usage: node scripts/rw-batch.mjs before BATCH.json --instance <instance-root> [--start-as-is]\n       node scripts/rw-batch.mjs abort --instance <instance-root>';
if (process.argv[2] === 'abort') {
  const [flag, root, ...extra] = process.argv.slice(3);
  if (flag !== '--instance' || !root || extra.length) { console.error(USAGE); process.exit(1); }
  print(abortBatch({ teamRoot: join(resolve(root), 'kit'), instanceRoot: resolve(root) }));
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
