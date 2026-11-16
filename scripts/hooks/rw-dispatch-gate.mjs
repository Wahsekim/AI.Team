#!/usr/bin/env node
// PreToolUse hook of a main-session dispatch: admits only the next call of the run (Agent,
// SendMessage) and records each agent hand-back. Exit 0 allows, exit 2 denies with the reason.
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideDispatch, DISPATCH_LOG } from '../../src/router-worker/dispatch.mjs';

const project = process.env.CLAUDE_PROJECT_DIR ?? '';
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
// Usage of one agent so far (input + cache_creation), read from its transcript with the kit's meter. Null when it cannot be read.
function meterOf(input) {
  const path = input.transcript_path, session = input.session_id;
  if (typeof path !== 'string' || typeof session !== 'string' || !session) return () => null;
  const at = path.indexOf(`/${session}/`), dir = at >= 0 ? path.slice(0, at + 1 + session.length) : join(dirname(path), session);
  return agentId => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../measure-spawn.mjs', import.meta.url)), dir, '--agent', agentId, '--json'], { encoding: 'utf8', timeout: 20000 });
    try { const row = JSON.parse(run.stdout).subagents.find(entry => entry.agentId === agentId); return Number.isSafeInteger(row?.harnessEq) ? row.harnessEq : null; } catch { return null; }
  };
}
let verdict;
try {
  const input = JSON.parse(readFileSync(0, 'utf8')), log = join(project, DISPATCH_LOG);
  let events = [];
  try { events = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  verdict = decideDispatch({ input, launch: readJSON(join(project, 'rw-launch.json')), events, meter: meterOf(input) });
  // An admitted call that cannot be recorded would be admitted again: refuse it instead.
  if (verdict.event) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...verdict.event }) + '\n');
} catch { verdict = { decision: 'deny', reason: 'The dispatch gate could not read its input or its log' }; }
if (verdict.decision === 'deny') { console.error(`Router/Worker dispatch gate: ${verdict.reason}`); process.exitCode = 2; }
else if (verdict.updatedInput) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: verdict.updatedInput } }) + '\n');
