#!/usr/bin/env node
// Activate a Router/Worker draft for ONE disposable smoke run, in a new copy of the instance.
// Needs an owner approval file and the digest of that file as the caller reviewed it.
// No model or network. Writes only the new <name>.rw-active directory. Exit 0 activated, 2 refused, 1 usage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activateTeam } from '../src/router-worker/activate.mjs';

const [specFile, draftFile, destination, ...rest] = process.argv.slice(2), options = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!['--instance', '--approval', '--approval-digest'].includes(rest[i]) || !rest[i + 1]) { options.invalid = true; break; }
  options[rest[i]] = rest[i + 1];
}
if (!destination || options.invalid || !options['--instance'] || !options['--approval'] || !options['--approval-digest']) {
  console.error('usage: node kit/scripts/activate-router-worker.mjs SPEC.json DRAFT.json /abs/NEW.rw-active --instance <instance-root> --approval <approval.json> --approval-digest sha256:<64 hex>');
  process.exitCode = 1;
} else {
  let result;
  try {
    result = activateTeam(JSON.parse(readFileSync(specFile, 'utf8')), JSON.parse(readFileSync(draftFile, 'utf8')), resolve(destination),
      { instanceRoot: resolve(options['--instance']), approvalPath: resolve(options['--approval']), expectedApprovalDigest: options['--approval-digest'] });
  } catch { result = { errors: [{ code: 'INVALID_ACTIVATION', field: 'activation', reason: 'SPEC.json or DRAFT.json is not readable JSON' }] }; }
  if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
