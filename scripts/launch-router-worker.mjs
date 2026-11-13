#!/usr/bin/env node
// Launch host of one Router/Worker run in an activated disposable copy.
// prepare: freeze the run, take the product lease, arm the write boundary, observe the
// isolation gate, then write <copy>/rw-launch.json. Any refusal releases the lease.
// No model or network. Exit 0 prepared, 2 refused, 1 usage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch } from '../src/router-worker/launch.mjs';
import { loadMethods, MethodError } from '../src/router-worker/methods.mjs';

const [command, file, teamFlag, team, productFlag, product] = process.argv.slice(2);
if (command !== 'prepare' || !file || teamFlag !== '--team-root' || !team || productFlag !== '--product-root' || !product || process.argv.length !== 8) {
  console.error('usage: node scripts/launch-router-worker.mjs prepare RUN.json --team-root <activated copy> --product-root <product-root>   (RUN.json: {"run": {...}, "inputs": [...]})');
  process.exitCode = 1;
} else {
  let request;
  try { request = JSON.parse(readFileSync(file, 'utf8')); } catch { request = null; }
  const needsMethods = Array.isArray(request?.inputs) && request.inputs.some(input => input?.schemaVersion === 2
    && (input.catalog?.methods?.length || input.proposal?.checkMethodIds?.length));
  let result;
  try {
    result = request && typeof request === 'object'
      ? await prepareLaunch({ inputs: request.inputs, run: request.run, teamRoot: resolve(team), productRoot: resolve(product),
        hookPath: fileURLToPath(new URL('./hooks/rw-write-boundary.mjs', import.meta.url)), ...(needsMethods ? { methodBundle: loadMethods() } : {}) })
      : { errors: [{ code: 'LAUNCH_REFUSED', field: 'launch', reason: 'RUN.json is not readable JSON' }] };
  } catch (error) {
    if (!(error instanceof MethodError)) throw error;
    result = { errors: [error.finding] };
  }
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
