#!/usr/bin/env node
// Launch host of one Router/Worker run in an activated disposable copy.
// prepare: freeze the run, take the product lease, arm the write boundary, observe the
// isolation gate, then write <copy>/rw-launch.json. Any refusal releases the lease.
// close: account the engine return against that record, record what the run left in the
// product, release the lease, then write <copy>/rw-close.json.
// settle: match the metered agents to the calls, check the briefs, settle tickets and run,
// then write <copy>/rw-settlement.json.
// No model or network. Exit 0 prepared / closed clean, 2 refused or review, 1 usage.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch, closeLaunch } from '../src/router-worker/launch.mjs';
import { settleLaunch } from '../src/router-worker/launch-settle.mjs';
import { prepareRetry } from '../src/router-worker/launch-retry.mjs';
import { nextCall, DISPATCH_LOG, PLACEHOLDER } from '../src/router-worker/dispatch.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { loadMethods, MethodError } from '../src/router-worker/methods.mjs';

const [command, file, teamFlag, team, productFlag, product] = process.argv.slice(2);
const USAGE = 'usage: node scripts/launch-router-worker.mjs prepare RUN.json --team-root <activated copy> --product-root <product-root>   (RUN.json: {"run": {...}, "inputs": [...]})\n'
  + '       node scripts/launch-router-worker.mjs close RESULT.json --team-root <activated copy>   (RESULT.json: the engine return)\n'
  + '       node scripts/launch-router-worker.mjs settle RESULT.json METER.json --team-root <activated copy>   (METER.json: measure-spawn.mjs <session-dir> --json)\n'
  + '       node scripts/launch-router-worker.mjs retry REQUEST.json --team-root <activated copy>   (REQUEST.json: {"input", "divergence"}; prepares an exec continuation after a failed check)\n'
  + '       node scripts/launch-router-worker.mjs next --team-root <activated copy>   (main-session dispatch: the one call the gate admits next)\n'
  + '       main-session dispatch has no engine return: close --team-root <activated copy> [--pending-stopped], settle METER.json --team-root <activated copy>';
// The static launch preflight of the engine, run on the frozen arguments; its digest goes into them.
function launchManifest(args, { teamRoot, productRoot }) {
  const dir = mkdtempSync(join(tmpdir(), 'rw-launch-manifest-'));
  try {
    const file = join(dir, 'args.json'); writeFileSync(file, JSON.stringify(args));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./preflight-run.mjs', import.meta.url)), file, '--team-root', teamRoot, '--product-root', productRoot], { encoding: 'utf8' });
    let found;
    try { found = JSON.parse(run.stdout).launchManifestDigest; } catch { found = null; }
    if (run.status === 0 && /^sha256:[a-f0-9]{64}$/.test(found ?? '')) return { digest: found };
    const failures = (run.stderr ?? '').split('\n').filter(line => line.startsWith('FAIL - ')).map(line => line.split(':')[0]).join('; ');
    return { errors: [{ code: 'PREFLIGHT_FAILED', field: 'launch', reason: `The launch preflight did not pass: ${failures || 'no manifest produced'}` }] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const print = result => {
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
};
if (command === 'close' && file === '--team-root' && teamFlag && (process.argv.length === 5 || (process.argv.length === 6 && team === '--pending-stopped'))) {
  // A main-session run has no engine return; close reads the dispatch log.
  const result = closeLaunch({ teamRoot: resolve(teamFlag), pendingStopped: team === '--pending-stopped' });
  print(result);
  if (!result.errors && result.status !== 'clean') process.exitCode = 2;
} else if (command === 'settle' && file && teamFlag === '--team-root' && team && process.argv.length === 6) {
  const result = settleLaunch({ teamRoot: resolve(team), meter: readJSON(file), rules: loadRetryRules() });
  print(result);
  if (!result.errors && result.status !== 'clear') process.exitCode = 2;
} else if (command === 'next' && file === '--team-root' && teamFlag && process.argv.length === 5) {
  // The one call the dispatch gate admits next. The text of the call stays with the gate: the main session sends the placeholder.
  let events = [];
  try { events = readFileSync(join(resolve(teamFlag), DISPATCH_LOG), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { events = []; }
  const { prompt, message, wrapper, ...call } = nextCall({ launch: readJSON(join(resolve(teamFlag), 'rw-launch.json')), events });
  process.stdout.write(JSON.stringify(['agent', 'message'].includes(call.action) ? { ...call, placeholder: PLACEHOLDER } : call, null, 2) + '\n');
  if (call.action === 'refused') process.exitCode = 2;
} else if (command === 'retry' && file && teamFlag === '--team-root' && team && process.argv.length === 6) {
  const request = readJSON(file), needsMethods = request?.input?.schemaVersion === 2 && (request.input.catalog?.methods?.length || request.input.proposal?.checkMethodIds?.length);
  let result;
  try { result = prepareRetry({ teamRoot: resolve(team), request, rules: loadRetryRules(), ...(needsMethods ? { methodBundle: loadMethods() } : {}) }); }
  catch (error) { if (!(error instanceof MethodError)) throw error; result = { errors: [error.finding] }; }
  print(result);
} else if (command === 'settle' && file && teamFlag && team === '--team-root' && productFlag && process.argv.length === 7) {
  const result = settleLaunch({ teamRoot: resolve(productFlag), result: readJSON(file), meter: readJSON(teamFlag), rules: loadRetryRules() });
  print(result);
  if (!result.errors && result.status !== 'clear') process.exitCode = 2;
} else if (command === 'close' && file && teamFlag === '--team-root' && team && process.argv.length === 6) {
  const result = closeLaunch({ teamRoot: resolve(team), result: readJSON(file) });
  print(result);
  if (!result.errors && result.status !== 'clean') process.exitCode = 2;
} else if (command !== 'prepare' || !file || teamFlag !== '--team-root' || !team || productFlag !== '--product-root' || !product || process.argv.length !== 8) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  const request = readJSON(file) ?? null;
  const needsMethods = Array.isArray(request?.inputs) && request.inputs.some(input => input?.schemaVersion === 2
    && (input.catalog?.methods?.length || input.proposal?.checkMethodIds?.length));
  let result;
  try {
    result = request && typeof request === 'object'
      ? await prepareLaunch({ inputs: request.inputs, run: request.run, teamRoot: resolve(team), productRoot: resolve(product),
        hookPath: fileURLToPath(new URL('./hooks/rw-write-boundary.mjs', import.meta.url)),
        gateHookPath: fileURLToPath(new URL('./hooks/rw-dispatch-gate.mjs', import.meta.url)), manifest: launchManifest, ...(needsMethods ? { methodBundle: loadMethods() } : {}) })
      : { errors: [{ code: 'LAUNCH_REFUSED', field: 'launch', reason: 'RUN.json is not readable JSON' }] };
  } catch (error) {
    if (!(error instanceof MethodError)) throw error;
    result = { errors: [error.finding] };
  }
  print(result);
}
