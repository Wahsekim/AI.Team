#!/usr/bin/env node
// Settle measured usage against a ticket's retry journal and report the observed
// 'budget' admission gate (rollout gate G-04). Offline and read-only.
// Exit 0 clear, 2 blocked/unknown/invalid, 1 usage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { settleAgainstJournal } from '../src/router-worker/settlement.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';

const argv = process.argv.slice(2);
if (!argv[0] || argv[0].startsWith('-') || ![1, 3].includes(argv.length) || (argv.length === 3 && argv[1] !== '--instance')) {
  console.error('usage: node scripts/settle-router-worker.mjs REQUEST.json [--instance <instance-root>]   (REQUEST.json: {"ledger", "retryJournal", "nextEstimateTokens"?})');
  process.exitCode = 1;
} else {
  try {
    const request = JSON.parse(readFileSync(argv[0], 'utf8'));
    const rules = loadRetryRules(argv[2] ? { instanceRoot: resolve(argv[2]) } : {});
    const result = settleAgainstJournal({ ledger: request.ledger, retryJournal: request.retryJournal, rules, nextEstimateTokens: request.nextEstimateTokens });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.budgetGate !== 'clear') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ errors: [{ code: error?.code ?? 'INVALID_SETTLEMENT', field: 'request', reason: 'The request, ledger, journal or rule sources could not be read or validated' }] }));
    process.exitCode = 2;
  }
}
