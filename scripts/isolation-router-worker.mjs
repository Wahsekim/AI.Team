#!/usr/bin/env node
// Observe the Router/Worker 'runtime-isolation' admission gate (rollout gate G-02).
// Read-only: no model, network or write. Exit 0 clear, 2 blocked/unknown/invalid, 1 usage.
import { resolve } from 'node:path';
import { observeIsolation } from '../src/router-worker/isolation.mjs';

const argv = process.argv.slice(2), options = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--team-root', '--product-root'].includes(argv[i]) || !argv[i + 1]) { options.invalid = true; break; }
  options[argv[i]] = resolve(argv[i + 1]);
}
if (options.invalid || !options['--team-root'] || !options['--product-root']) {
  console.error('usage: node scripts/isolation-router-worker.mjs --team-root <team-root> --product-root <product-root> (observes only; never dispatches)');
  process.exitCode = 1;
} else {
  const result = observeIsolation({ teamRoot: options['--team-root'], productRoot: options['--product-root'] });
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.status !== 'clear') process.exitCode = 2; }
}
