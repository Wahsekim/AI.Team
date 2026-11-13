#!/usr/bin/env node
// Arm the runtime write boundary of one Router/Worker run in an activated disposable copy.
// Writes .claude/rw-write-boundary.json and a PreToolUse hook entry in .claude/settings.json
// of that copy only. No model or network. Exit 0 armed, 2 refused, 1 usage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armBoundary } from '../src/router-worker/write-boundary.mjs';

const [file, teamFlag, team, productFlag, product] = process.argv.slice(2);
if (!file || teamFlag !== '--team-root' || !team || productFlag !== '--product-root' || !product || process.argv.length !== 7) {
  console.error('usage: node scripts/arm-boundary-router-worker.mjs RUN.json --team-root <activated copy> --product-root <product-root>   (RUN.json: {"run": {...}, "inputs": [...]})');
  process.exitCode = 1;
} else {
  let request;
  try { request = JSON.parse(readFileSync(file, 'utf8')); } catch { request = null; }
  const result = request && typeof request === 'object'
    ? armBoundary({ inputs: request.inputs, teamRoot: resolve(team), productRoot: resolve(product), hookPath: fileURLToPath(new URL('./hooks/rw-write-boundary.mjs', import.meta.url)) })
    : { errors: [{ code: 'BOUNDARY_REFUSED', field: 'boundary', reason: 'RUN.json is not readable JSON' }] };
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
