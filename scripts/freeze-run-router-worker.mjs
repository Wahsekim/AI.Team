#!/usr/bin/env node
// Freeze the complete count-engine arguments of a Router/Worker run (rollout gate G-05).
// Offline: no model, network or write. Prints {args, record}; the record is never launchable.
// Exit 0 frozen, 2 refused, 1 usage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freezeRun } from '../src/router-worker/run-args.mjs';
import { loadMethods, MethodError } from '../src/router-worker/methods.mjs';

const [file, flag, root] = process.argv.slice(2);
if (!file || flag !== '--team-root' || !root || process.argv.length !== 5) {
  console.error('usage: node scripts/freeze-run-router-worker.mjs RUN.json --team-root <team-root>   (RUN.json: {"run": {...}, "inputs": [...]})');
  process.exitCode = 1;
} else {
  let request;
  try { request = JSON.parse(readFileSync(file, 'utf8')); } catch { request = null; }
  const needsMethods = Array.isArray(request?.inputs) && request.inputs.some(input => input?.schemaVersion === 2
    && (input.catalog?.methods?.length || input.proposal?.checkMethodIds?.length));
  let result;
  try {
    // The bundle is the pinned one of the kit this script runs from, as in compile-router-worker.mjs.
    result = request && typeof request === 'object'
      ? await freezeRun({ inputs: request.inputs, run: request.run, teamRoot: resolve(root), ...(needsMethods ? { methodBundle: loadMethods() } : {}) })
      : { errors: [{ code: 'INVALID_RUN', field: 'run', reason: 'RUN.json is not readable JSON' }] };
  } catch (error) {
    if (!(error instanceof MethodError)) throw error;
    result = { errors: [error.finding] };
  }
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
