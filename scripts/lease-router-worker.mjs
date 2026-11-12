#!/usr/bin/env node
// Exclusive ownership lease on a product repository (rollout gate G-02).
// No model or network. Writes one file in the product's Git directory, never its work tree.
// Exit 0 done, 2 refused or invalid, 1 usage.
import { resolve } from 'node:path';
import { acquireLease, readLease, releaseLease } from '../src/router-worker/lease.mjs';

const [command, ...argv] = process.argv.slice(2), options = {};
const NEEDS = { acquire: ['--team-root', '--product-root'], status: ['--product-root'], release: ['--product-root', '--lease'] };
for (let i = 0; i < argv.length; i += 2) {
  if (!NEEDS[command]?.includes(argv[i]) || !argv[i + 1]) { options.invalid = true; break; }
  options[argv[i]] = argv[i] === '--lease' ? argv[i + 1] : resolve(argv[i + 1]);
}
if (!NEEDS[command] || options.invalid || NEEDS[command].some(name => !options[name])) {
  console.error('usage: node scripts/lease-router-worker.mjs acquire --team-root <team-root> --product-root <product-root>\n'
    + '       node scripts/lease-router-worker.mjs status --product-root <product-root>\n'
    + '       node scripts/lease-router-worker.mjs release --product-root <product-root> --lease <digest>');
  process.exitCode = 1;
} else {
  const productRoot = options['--product-root'];
  const result = command === 'acquire' ? acquireLease({ teamRoot: options['--team-root'], productRoot })
    : command === 'status' ? readLease({ productRoot }) : releaseLease({ productRoot, lease: options['--lease'] });
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
