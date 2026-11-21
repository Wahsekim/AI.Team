#!/usr/bin/env node
// The batch commands of a standing Router/Worker team (ADR 0010, decisions 8 to 12).
// before BATCH.json --instance <instance-root> [--start-as-is]
//   Checks and freezes the tickets, checks the product repository, computes the ceiling, takes the lock and
//   opens the write boundary. Prints the batch record; its `args` are the arguments of run-n-rounds.
// BATCH.json: {"tickets": [{"id", "title", "goal", "acceptance": [...], "paths": [...], "estimate": {"execTokens", "checkTokens", "reworkTokens"}}],
//              "verificationCommands": [...], "sensitivePaths": [...], "nextLifecycleNumber": n, "runId"?, "date"?}
// abort --instance <instance-root>
//   Clears a batch that will not be run, or what a "before" that died left behind. Also ends a review.
// after RESULT.json --instance <instance-root>
//   RESULT.json is the engine's return. Matches it against the frozen batch, compares the product with the
//   tickets' paths, closes the write boundary, releases the lock and plans the commits. Exit 2 when in review.
// settle METER.json --instance <instance-root> [--run <run id>]
//   METER.json is `measure-spawn.mjs <session-dir> --json`. Sets each ticket's measured usage against its
//   authorization, for the batch that after closed or for an archived one. Exit 2 when it is in review.
//   The next "before" is refused until the batch is settled.
// settle --not-metered "<reason>" --instance <instance-root> [--run <run id>]
//   Marks a batch whose usage cannot be measured, with the reason, in the place of its settlement.
// review-brief --reviewer <security|architect> --instance <instance-root> [--ticket <id> ...]
//   For a batch in review: runs the confirmed verification commands, prints the reviewer's brief and records it,
//   sealed, in rw-batch-review-<reviewer>.json. --ticket adds an elective review, which binds like a required one.
// review --reviewer <security|architect> --transcript <agent-*.jsonl> --instance <instance-root> [REPORT.json]
//   Judges the reviewer's report from its own session transcript and records the verdict in rw-batch-reviews.json.
//   Exit 0 when the report is accepted (its tickets passed or rejected), 2 when it is refused or the review not obtained.
// review --no-answer "<reason>" --reviewer <security|architect> --instance <instance-root>
//   Records an attempt that brought no answer. A second failed attempt means the review was not obtained.
// commit --instance <instance-root>
//   One commit per ticket that passed, on the batch's branch, then archives the batch under batches/<run id>/.
//   A ticket a review rejected or could not judge, and every ticket after it, stays uncommitted. Ends the review.
// No model or network. Exit 0 done and clean, 2 refused or in review, 1 usage.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeBatch, abortBatch } from '../src/router-worker/batch.mjs';
import { afterBatch, commitBatch } from '../src/router-worker/batch-close.mjs';
import { settleBatch, markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { reviewBrief } from '../src/router-worker/review-brief.mjs';
import { judgeReview, recordNoAnswer } from '../src/router-worker/review-judge.mjs';

const print = result => { if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; } else process.stdout.write(JSON.stringify(result, null, 2) + '\n'); };
const USAGE = 'usage: node scripts/rw-batch.mjs before BATCH.json --instance <instance-root> [--start-as-is]\n       node scripts/rw-batch.mjs after RESULT.json --instance <instance-root>\n       node scripts/rw-batch.mjs settle METER.json --instance <instance-root> [--run <run id>]\n       node scripts/rw-batch.mjs settle --not-metered "<reason>" --instance <instance-root> [--run <run id>]\n       node scripts/rw-batch.mjs review-brief --reviewer <security|architect> --instance <instance-root> [--ticket <id> ...]\n       node scripts/rw-batch.mjs review --reviewer <security|architect> --transcript <agent-*.jsonl> --instance <instance-root> [REPORT.json]\n       node scripts/rw-batch.mjs review --no-answer "<reason>" --reviewer <security|architect> --instance <instance-root>\n       node scripts/rw-batch.mjs commit --instance <instance-root>\n       node scripts/rw-batch.mjs abort --instance <instance-root>';
if (['abort', 'commit'].includes(process.argv[2])) {
  const [flag, root, ...extra] = process.argv.slice(3);
  if (flag !== '--instance' || !root || extra.length) { console.error(USAGE); process.exit(1); }
  print((process.argv[2] === 'abort' ? abortBatch : commitBatch)({ teamRoot: join(resolve(root), 'kit'), instanceRoot: resolve(root) }));
  process.exit();
}
if (process.argv[2] === 'review-brief') {
  const argv = process.argv.slice(3), options = { '--ticket': [] };
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--reviewer', '--instance', '--ticket'].includes(argv[i]) || argv[i + 1] === undefined || (argv[i] !== '--ticket' && options[argv[i]] !== undefined)) { console.error(USAGE); process.exit(1); }
    if (argv[i] === '--ticket') options['--ticket'].push(argv[i + 1]); else options[argv[i]] = argv[i + 1];
  }
  if (!options['--reviewer'] || !options['--instance']) { console.error(USAGE); process.exit(1); }
  const root = resolve(options['--instance']), made = reviewBrief({ teamRoot: join(root, 'kit'), instanceRoot: root, reviewer: options['--reviewer'], tickets: options['--ticket'] });
  // A brief is long: it is written out in full before the process ends.
  if (made.errors) print(made); else await new Promise(done => process.stdout.write(made.brief, done));
  process.exit();
}
if (process.argv[2] === 'review') {
  const argv = process.argv.slice(3), options = {}, files = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { files.push(argv[i]); continue; }
    if (!['--reviewer', '--transcript', '--instance', '--no-answer'].includes(argv[i]) || argv[i + 1] === undefined || options[argv[i]] !== undefined) { console.error(USAGE); process.exit(1); }
    options[argv[i]] = argv[++i];
  }
  const silent = options['--no-answer'] !== undefined;
  if (!options['--reviewer'] || !options['--instance'] || (silent ? options['--transcript'] !== undefined || files.length : !options['--transcript'] || files.length > 1)) { console.error(USAGE); process.exit(1); }
  const root = resolve(options['--instance']), common = { teamRoot: join(root, 'kit'), instanceRoot: root, reviewer: options['--reviewer'] };
  let report; if (files.length) try { report = JSON.parse(readFileSync(files[0], 'utf8')); } catch { print({ errors: [{ code: 'REVIEW_REFUSED', field: 'review', reason: `${files[0]} is not readable JSON` }] }); process.exit(); }
  const judged = silent ? recordNoAnswer({ ...common, reason: options['--no-answer'] }) : judgeReview({ ...common, transcript: resolve(options['--transcript']), ...(files.length ? { report } : {}) });
  print(judged);
  if (!judged.errors && judged.outcome !== 'accepted') process.exitCode = 2;
  process.exit();
}
if (process.argv[2] === 'settle' && process.argv[3] === '--not-metered') {
  const [reason, flag, root, runFlag, runId, ...extra] = process.argv.slice(4);
  if (reason === undefined || flag !== '--instance' || !root || (runFlag !== undefined && (runFlag !== '--run' || !runId)) || extra.length) { console.error(USAGE); process.exit(1); }
  print(markNotMetered({ teamRoot: join(resolve(root), 'kit'), instanceRoot: resolve(root), reason, ...(runId ? { runId } : {}) }));
  process.exit();
}
if (process.argv[2] === 'settle') {
  const [meterFile, flag, root, runFlag, runId, ...extra] = process.argv.slice(3);
  if (!meterFile || flag !== '--instance' || !root || (runFlag !== undefined && (runFlag !== '--run' || !runId)) || extra.length) { console.error(USAGE); process.exit(1); }
  let meter, rules; try { meter = JSON.parse(readFileSync(meterFile, 'utf8')); } catch { print({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: `${meterFile} is not readable JSON` }] }); process.exit(); }
  // The retry rules are the team's own charter, read through the kit that serves this command.
  try { rules = loadRetryRules({ instanceRoot: resolve(root) }); } catch (error) { print({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: `The retry rules of the team could not be read: ${error?.message}` }] }); process.exit(); }
  const settled = settleBatch({ teamRoot: join(resolve(root), 'kit'), instanceRoot: resolve(root), meter, rules, ...(runId ? { runId } : {}) });
  print(settled);
  if (!settled.errors && settled.status !== 'clear') process.exitCode = 2;
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
