#!/usr/bin/env node
// PreToolUse hook: refuses file-tool writes of the Router/Worker wrappers outside the
// armed write boundary. Exit 0 allows, exit 2 denies with the reason on stderr.
import { readFileSync } from 'node:fs';
import { readBoundary, decideWrite } from '../../src/router-worker/write-boundary.mjs';

let verdict;
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  verdict = decideWrite({ input, boundary: readBoundary(process.env.CLAUDE_PROJECT_DIR ?? '') });
} catch { verdict = { decision: 'deny', reason: 'The write-boundary hook could not read its input' }; }
if (verdict.decision === 'deny') { console.error(`Router/Worker write boundary: ${verdict.reason}`); process.exitCode = 2; }
