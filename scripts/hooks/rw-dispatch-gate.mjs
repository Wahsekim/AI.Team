#!/usr/bin/env node
// PreToolUse hook of a main-session dispatch: admits only the next call of the run (Agent,
// SendMessage) and records each agent hand-back. Exit 0 allows, exit 2 denies with the reason.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideDispatch, DISPATCH_LOG } from '../../src/router-worker/dispatch.mjs';

const project = process.env.CLAUDE_PROJECT_DIR ?? '';
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
let verdict;
try {
  const input = JSON.parse(readFileSync(0, 'utf8')), log = join(project, DISPATCH_LOG);
  let events = [];
  try { events = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  verdict = decideDispatch({ input, launch: readJSON(join(project, 'rw-launch.json')), events });
  // An admitted call that cannot be recorded would be admitted again: refuse it instead.
  if (verdict.event) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...verdict.event }) + '\n');
} catch { verdict = { decision: 'deny', reason: 'The dispatch gate could not read its input or its log' }; }
if (verdict.decision === 'deny') { console.error(`Router/Worker dispatch gate: ${verdict.reason}`); process.exitCode = 2; }
