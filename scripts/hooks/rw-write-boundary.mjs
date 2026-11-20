#!/usr/bin/env node
// PreToolUse hook: refuses file-tool writes of the Router/Worker wrappers outside the
// armed write boundary, refuses any session's file-tool write of the team's limits,
// and approves the verification commands of the open batch.
// Exit 0 allows, exit 2 denies with the reason on stderr; an approval is the
// permission decision printed on stdout.
// Every call is appended to .claude/rw-write-boundary.log.jsonl of the project.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundary, decideCall, logEntry, LOG_FILE } from '../../src/router-worker/write-boundary.mjs';

const project = process.env.CLAUDE_PROJECT_DIR ?? '';
let verdict, input = null, boundary = null;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
  boundary = readBoundary(project);
  verdict = decideCall({ input, boundary, projectDir: project });
} catch { verdict = { decision: 'deny', reason: 'The write-boundary hook could not read its input' }; }
// The log explains a run afterwards; failing to write it must not change the verdict.
try { appendFileSync(join(project, LOG_FILE), JSON.stringify(logEntry({ input, boundary, decision: verdict.decision, at: new Date().toISOString() })) + '\n'); } catch { /* no project directory */ }
if (verdict.decision === 'deny') { console.error(`Router/Worker write boundary: ${verdict.reason}`); process.exitCode = 2; }
if (verdict.decision === 'approve') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'A verification command the owner confirmed for this team' } }) + '\n');
