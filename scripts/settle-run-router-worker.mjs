#!/usr/bin/env node
// Settle one frozen Router/Worker run: its ticket settlements plus the Guardian call.
// Offline and read-only. Exit 0 clear, 2 blocked/unknown/invalid, 1 usage.
import { readFileSync } from 'node:fs';
import { settleRun } from '../src/router-worker/run-settlement.mjs';

const argv = process.argv.slice(2);
if (argv.length !== 1 || argv[0].startsWith('-')) {
  console.error('usage: node scripts/settle-run-router-worker.mjs REQUEST.json   (REQUEST.json: {"record", "tickets", "guardian"})');
  process.exitCode = 1;
} else {
  try {
    const request = JSON.parse(readFileSync(argv[0], 'utf8'));
    const result = settleRun({ record: request.record, tickets: request.tickets, guardian: request.guardian });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.runGate !== 'clear') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ errors: [{ code: error?.code ?? 'INVALID_RUN_SETTLEMENT', field: 'request', reason: error?.code ? error.message : 'The request could not be read' }] }));
    process.exitCode = 2;
  }
}
