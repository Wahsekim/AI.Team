#!/usr/bin/env node
// Read the verification commands of a project from its own profiles/stack.md and,
// when a compiler input is given, check that the input carries exactly those (rollout gate G-01).
// Offline and read-only. Exit 0 read/bound, 2 refused, 1 usage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readStackSource, checkStackBinding } from '../src/router-worker/stack-source.mjs';

const [flag, root, file, ...rest] = process.argv.slice(2);
if (flag !== '--root' || !root || rest.length) {
  console.error('usage: node scripts/stack-source-router-worker.mjs --root <dir holding profiles/stack.md> [INPUT.json]');
  process.exitCode = 1;
} else {
  let result = readStackSource({ root: resolve(root) });
  if (!result.errors && file) {
    let input = null;
    try { input = JSON.parse(readFileSync(file, 'utf8')); } catch { /* reported as a mismatch below */ }
    const binding = checkStackBinding(input, result);
    result = binding.errors ? binding : { ...result, binding };
  }
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
