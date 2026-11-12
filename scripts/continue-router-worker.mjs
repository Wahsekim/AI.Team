#!/usr/bin/env node
// Compile a retry as a continuation of the same ticket and duty (rollout gate G-03).
// Offline: no model, network or write. The result is never launchable and is not an engine plan item.
// Exit 0 compiled, 2 refused, 1 usage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileContinuation } from '../src/router-worker/continuation.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';

const argv = process.argv.slice(2);
if (!argv[0] || argv[0].startsWith('-') || ![1, 3].includes(argv.length) || (argv.length === 3 && argv[1] !== '--instance')) {
  console.error('usage: node scripts/continue-router-worker.mjs REQUEST.json [--instance <instance-root>]   (REQUEST.json: {"input", "journal", "duty", "divergence"})');
  process.exitCode = 1;
} else {
  let result;
  try {
    const request = JSON.parse(readFileSync(argv[0], 'utf8'));
    const rules = loadRetryRules(argv[2] ? { instanceRoot: resolve(argv[2]) } : {});
    result = compileContinuation({ input: request.input, journal: request.journal, rules, duty: request.duty, divergence: request.divergence });
  } catch (error) {
    result = { errors: [{ code: error?.code ?? 'INVALID_CONTINUATION', field: 'request', reason: 'REQUEST.json or the retry rule sources could not be read' }] };
  }
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
