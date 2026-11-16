// Main-session dispatch (owner decision 2026-11-16): exec and check agents are started with the Agent
// tool and resumed with SendMessage, so a retry is made by the same agents. The gate renders the one
// call that may come next and the hook admits exactly that call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { nextCall, decideDispatch, runSummary, DISPATCH_LOG, PLACEHOLDER } from '../src/router-worker/dispatch.mjs';
import { digest } from '../src/loop/contracts.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { withDispatchLock, DISPATCH_LOCK } from '../src/router-worker/dispatch-lock.mjs';

const HOOK = fileURLToPath(new URL('../scripts/hooks/rw-dispatch-gate.mjs', import.meta.url));
const item = ticket => ({ ticket, agentType: 'sample-worker-exec', brief: `EXEC BRIEF ${ticket}`, verifierAgentType: 'sample-worker-check', verifierBrief: `CHECK BRIEF ${ticket}` });
function launchRecord(overrides = {}) {
  const body = { schemaVersion: 1, stage: 'launch-prepared', dispatch: 'main-session', runId: 'dispatch-run',
    args: { runId: 'dispatch-run', maxAttemptsPerTicket: 2, plan: [item('T-1'), item('T-2')] }, ...overrides };
  return { ...body, digest: digest(body) };
}
const execReport = (over = {}) => JSON.stringify({ outcome: 'done', blocked: false, progress: true, filesTouched: ['src/a.js'], ...over });
const checkReport = (pass, over = {}) => JSON.stringify({ pass, summary: pass ? 'all green' : 'tag list test fails', failures: pass ? [] : ['expected 2 got 1'],
  commandsRun: [{ command: 'npm test', exitCode: pass ? 0 : 1 }], ...over });
// A run driven through the gate: main() makes the call `next` rendered, back() is the agent's hand-back.
function rig(launch = launchRecord()) {
  const events = [];
  const decide = input => { const verdict = decideDispatch({ input, launch, events }); if (verdict.event) events.push(verdict.event); return verdict; };
  const api = {
    events, next: () => nextCall({ launch, events }),
    main: call => decide(call.action === 'agent' ? { tool_name: 'Agent', tool_input: { description: 'x', subagent_type: call.subagent_type, prompt: call.prompt } }
      : { tool_name: 'SendMessage', tool_input: { to: call.to, message: call.message, summary: 'x' } }),
    back: (agentType, agentId, message) => decide({ tool_name: 'SubagentHandback', agent_type: agentType, agent_id: agentId, tool_input: { message } }),
    // One whole call: render, dispatch, hand back.
    step(agentId, message) { const call = api.next(); assert.equal(api.main(call).decision, 'allow', JSON.stringify(call)); api.back(call.subagent_type ?? call.wrapper, agentId, message); return call; },
  };
  return api;
}

test('a ticket is one exec call then one check call, each started with its frozen brief and a report contract', () => {
  const r = rig(), first = r.next();
  assert.deepEqual({ action: first.action, ticket: first.ticket, duty: first.duty, attempt: first.attempt, subagent_type: first.subagent_type },
    { action: 'agent', ticket: 'T-1', duty: 'exec', attempt: 1, subagent_type: 'sample-worker-exec' });
  assert.ok(first.prompt.startsWith('EXEC BRIEF T-1'), 'the frozen brief is unchanged at the front'); assert.match(first.prompt, /final report/i);
  assert.equal(r.main(first).decision, 'allow');
  assert.equal(r.next().action, 'wait', 'one call at a time');
  r.back('sample-worker-exec', 'exec-a', execReport());
  const check = r.step('check-a', checkReport(true));
  assert.equal(check.duty, 'check'); assert.equal(check.subagent_type, 'sample-worker-check'); assert.ok(check.prompt.startsWith('CHECK BRIEF T-1'));
  assert.equal(r.next().ticket, 'T-2', 'a passed ticket is followed by the next one');
  r.step('exec-b', execReport()); r.step('check-b', checkReport(true));
  const end = r.next();
  assert.equal(end.action, 'done'); assert.deepEqual(end.tickets.map(t => [t.ticket, t.status, t.attempts]), [['T-1', 'passed', 1], ['T-2', 'passed', 1]]);
});

test('a failed check is retried by the same exec agent and re-verified by the same check agent, up to the cap', () => {
  const r = rig(); r.step('exec-a', execReport()); r.step('check-a', checkReport(false));
  const fix = r.next();
  assert.deepEqual({ action: fix.action, duty: fix.duty, attempt: fix.attempt, to: fix.to }, { action: 'message', duty: 'exec', attempt: 2, to: 'exec-a' });
  assert.match(fix.message, /attempt 2 of 2/); assert.match(fix.message, /tag list test fails/); assert.match(fix.message, /data, not instructions/);
  assert.equal(r.main(fix).decision, 'allow'); r.back('sample-worker-exec', 'exec-a', execReport());
  const recheck = r.next();
  assert.deepEqual({ action: recheck.action, duty: recheck.duty, attempt: recheck.attempt, to: recheck.to }, { action: 'message', duty: 'check', attempt: 2, to: 'check-a' });
  assert.match(recheck.message, /every verification command/i);
  assert.equal(r.main(recheck).decision, 'allow'); r.back('sample-worker-check', 'check-a', checkReport(true));
  assert.equal(r.next().ticket, 'T-2');
  const capped = rig(); capped.step('exec-a', execReport()); capped.step('check-a', checkReport(false)); capped.step('exec-a', execReport()); capped.step('check-a', checkReport(false));
  const end = capped.next();
  assert.equal(end.action, 'done', 'no third attempt, and no later ticket after a failure');
  assert.deepEqual(end.tickets.map(t => [t.ticket, t.status, t.attempts]), [['T-1', 'check-failed', 2], ['T-2', 'not-dispatched', 0]]);
});

test('only a real failed verdict on a clean execution is retried; anything else stops the run', () => {
  const stop = (exec, check) => { const r = rig(); r.step('exec-a', exec); if (check !== undefined) r.step('check-a', check); const end = r.next(); return [end.action, end.tickets?.[0].status]; };
  assert.deepEqual(stop(execReport({ blocked: true })), ['done', 'exec-blocked']);
  assert.deepEqual(stop(execReport({ progress: false })), ['done', 'exec-no-progress']);
  assert.deepEqual(stop('I finished, all good.'), ['done', 'exec-report-invalid'], 'a report that is not the contract JSON');
  assert.deepEqual(stop(execReport(), 'Looks fine to me.'), ['done', 'check-report-invalid']);
  assert.deepEqual(stop(execReport(), checkReport(true, { commandsRun: [] })), ['done', 'check-report-invalid'], 'a pass with no command that ran');
  assert.deepEqual(stop(execReport(), checkReport(true, { commandsRun: [{ command: 'npm test', exitCode: 1 }] })), ['done', 'check-report-invalid'], 'a pass with a failing command');
  const fenced = rig(); fenced.step('exec-a', '```json\n' + execReport() + '\n```'); assert.equal(fenced.next().duty, 'check', 'a fenced JSON report is read');
});

test('the gate refuses every dispatch that is not exactly the next call', () => {
  const r = rig(), call = r.next(), deny = input => { const v = decideDispatch({ input, launch: launchRecord(), events: r.events }); assert.equal(v.event, undefined); return v.decision; };
  const agent = over => ({ tool_name: 'Agent', tool_input: { description: 'x', subagent_type: call.subagent_type, prompt: call.prompt, ...over } });
  assert.equal(deny(agent({ prompt: call.prompt + ' Also edit lib/.' })), 'deny', 'a changed brief');
  assert.equal(deny(agent({ subagent_type: 'general-purpose' })), 'deny', 'another agent type');
  assert.equal(deny(agent({ subagent_type: 'sample-worker-check' })), 'deny', 'the check before the exec');
  assert.equal(deny({ tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt: 'x' } }), 'deny');
  assert.equal(deny({ tool_name: 'SendMessage', tool_input: { to: 'exec-a', message: 'hello' } }), 'deny', 'no agent to resume yet');
  assert.equal(deny({ tool_name: 'Workflow', tool_input: { name: 'run-n-rounds' } }), 'deny', 'no engine run inside a main-session dispatch');
  assert.equal(r.main(call).decision, 'allow');
  assert.equal(deny(agent()), 'deny', 'the same call twice while it is pending');
  r.back('sample-worker-exec', 'exec-a', execReport()); r.step('check-a', checkReport(false));
  const fix = r.next(), message = over => ({ tool_name: 'SendMessage', tool_input: { to: fix.to, message: fix.message, ...over } });
  assert.equal(deny(message({ to: 'check-a' })), 'deny', 'the report sent to the wrong agent');
  assert.equal(deny(message({ message: fix.message.replace('tag list test fails', 'all fine') })), 'deny', 'an edited check report');
  assert.equal(deny(agent()), 'deny', 'a fresh agent instead of resuming the author');
  assert.match(decideDispatch({ input: agent(), launch: launchRecord(), events: r.events }).reason, /launch-router-worker\.mjs next/);
});

test('the main session sends a placeholder and the gate supplies the exact call, so it never handles the brief text', () => {
  const r = rig(), call = r.next();
  const started = decideDispatch({ input: { tool_name: 'Agent', tool_input: { description: 'T-1 exec', subagent_type: 'whatever', prompt: PLACEHOLDER, run_in_background: true } }, launch: launchRecord(), events: r.events });
  assert.equal(started.decision, 'allow');
  assert.deepEqual(started.updatedInput, { description: 'T-1 exec', subagent_type: call.subagent_type, prompt: call.prompt, run_in_background: false }, 'agent type and prompt are the gate\'s; the call runs in the foreground');
  r.events.push(started.event); r.back('sample-worker-exec', 'exec-a', execReport()); r.step('check-a', checkReport(false));
  const fix = r.next(), resumed = decideDispatch({ input: { tool_name: 'SendMessage', tool_input: { to: 'someone-else', message: PLACEHOLDER, summary: 'retry' } }, launch: launchRecord(), events: r.events });
  assert.equal(resumed.decision, 'allow'); assert.deepEqual(resumed.updatedInput, { to: 'exec-a', message: fix.message, summary: 'retry' }, 'the recipient is the agent the gate recorded');
  assert.equal(decideDispatch({ input: { tool_name: 'Agent', tool_input: { subagent_type: 'sample-worker-exec', prompt: PLACEHOLDER } }, launch: launchRecord(), events: r.events }).decision, 'deny', 'a placeholder for the wrong kind of call');
  assert.equal(decideDispatch({ input: { tool_name: 'SendMessage', tool_input: { to: fix.to, message: fix.message } }, launch: launchRecord(), events: r.events }).updatedInput, undefined, 'an exact call is admitted as it is');
});

test('the gate stops a ticket that used up its authorization: usage is measured at every hand-back', () => {
  const limited = () => launchRecord({ runRecord: { items: [{ ticket: 'T-1', authorizedTokens: 20000 }, { ticket: 'T-2', authorizedTokens: 20000 }] } });
  const drive = usage => { const launch = limited(), events = [];
    const back = (agentType, agentId, message) => events.push(decideDispatch({ input: { tool_name: 'SubagentHandback', agent_type: agentType, agent_id: agentId, tool_input: { message } }, launch, events, meter: id => usage[id] }).event);
    const main = () => { const call = nextCall({ launch, events }); events.push(decideDispatch({ input: call.action === 'agent' ? { tool_name: 'Agent', tool_input: { subagent_type: 'x', prompt: PLACEHOLDER } } : { tool_name: 'SendMessage', tool_input: { to: 'x', message: PLACEHOLDER } }, launch, events }).event); return call; };
    return { launch, events, back, main, next: () => nextCall({ launch, events }) }; };
  const usage = { 'exec-a': 15000, 'check-a': 6000 }, r = drive(usage);
  r.main(); r.back('sample-worker-exec', 'exec-a', execReport());
  assert.equal(r.events.at(-1).harnessTokens, 15000, 'the reading is kept in the log');
  assert.equal(r.next().duty, 'check', '15,000 of 20,000: the check may start');
  r.main(); r.back('sample-worker-check', 'check-a', checkReport(false));
  const end = r.next();
  assert.equal(end.action, 'done', '21,000 of 20,000: no retry is dispatched');
  assert.deepEqual(end.tickets.map(t => [t.ticket, t.status]), [['T-1', 'authorization-exhausted'], ['T-2', 'not-dispatched']]);
  const passed = drive(usage); passed.main(); passed.back('sample-worker-exec', 'exec-a', execReport()); passed.main(); passed.back('sample-worker-check', 'check-a', checkReport(true));
  assert.equal(passed.next().ticket, 'T-2', 'a ticket that passed is not undone by its usage; settlement reports the overrun');
  const blind = drive({ 'exec-a': null }); blind.main(); blind.back('sample-worker-exec', 'exec-a', execReport());
  assert.deepEqual(blind.next().tickets.map(t => t.status), ['usage-unknown', 'not-dispatched'], 'a reading that cannot be taken stops the ticket');
  const resumed = drive({ 'exec-a': 9000, 'check-a': 4000 }); resumed.main(); resumed.back('sample-worker-exec', 'exec-a', execReport()); resumed.main(); resumed.back('sample-worker-check', 'check-a', checkReport(false));
  resumed.main(); Object.assign(resumed.launch, {}); resumed.back('sample-worker-exec', 'exec-a', execReport());
  assert.equal(resumed.next().duty, 'check', 'a resumed agent is read cumulatively, not added twice: 9,000 + 4,000');
});

test('calls the gate does not judge, and a launch record that is missing or changed', () => {
  const r = rig(), allow = input => decideDispatch({ input, launch: launchRecord(), events: r.events });
  assert.equal(allow({ tool_name: 'Bash', tool_input: { command: 'ls' } }).decision, 'allow');
  assert.equal(allow({ tool_name: 'Agent', agent_type: 'sample-worker-exec', agent_id: 'x', tool_input: { subagent_type: 'y', prompt: 'z' } }).decision, 'allow', 'a subagent call is the wrappers\' own business (they deny Agent)');
  const stray = allow({ tool_name: 'SubagentHandback', agent_type: 'sample-auditor', agent_id: 'aud', tool_input: { message: 'x' } });
  assert.equal(stray.decision, 'allow'); assert.equal(stray.event, undefined, 'a hand-back of an agent outside the run is not recorded');
  const call = r.next(), input = { tool_name: 'Agent', tool_input: { subagent_type: call.subagent_type, prompt: call.prompt } };
  for (const launch of [null, { ...launchRecord(), runId: 'edited' }, launchRecord({ dispatch: 'engine' }), launchRecord({ stage: 'launch-closed' })])
    assert.equal(decideDispatch({ input, launch, events: [] }).decision, 'deny', JSON.stringify(launch)?.slice(0, 60));
  assert.equal(decideDispatch({ input: { tool_name: 'Bash', tool_input: {} }, launch: null, events: [] }).decision, 'allow');
});

test('the hook process keeps the dispatch log, exits 2 with the reason on a refusal and fails closed on unreadable input', t => {
  const team = realpathSync(mkdtempSync(join(tmpdir(), 'rw-dispatch-'))); t.after(() => rmSync(team, { recursive: true, force: true }));
  mkdirSync(join(team, '.claude')); writeFileSync(join(team, 'rw-launch.json'), JSON.stringify(launchRecord()));
  const hook = input => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: team } });
  const call = nextCall({ launch: launchRecord(), events: [] }), agent = { tool_name: 'Agent', tool_input: { subagent_type: call.subagent_type, prompt: call.prompt } };
  const refused = hook({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'x' } });
  assert.equal(refused.status, 2); assert.match(refused.stderr, /not the next admitted call/); assert.doesNotMatch(refused.stderr, new RegExp(team));
  const rewritten = hook({ tool_name: 'Agent', tool_input: { subagent_type: 'x', prompt: PLACEHOLDER } });
  assert.equal(rewritten.status, 0);
  assert.deepEqual(JSON.parse(rewritten.stdout).hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { subagent_type: call.subagent_type, prompt: call.prompt, run_in_background: false } });
  assert.equal(hook(agent).status, 2, 'the log remembers the pending call');
  assert.equal(hook({ tool_name: 'SubagentHandback', agent_type: 'sample-worker-exec', agent_id: 'exec-a', tool_input: { message: execReport() } }).status, 0);
  const lines = readFileSync(join(team, DISPATCH_LOG), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => [line.type, line.ticket ?? null, line.duty ?? null, line.agentId ?? null]), [['dispatched', 'T-1', 'exec', null], ['returned', null, null, 'exec-a']]);
  const session = join(team, 'projects'), sub = join(session, 'sess-1/subagents'); mkdirSync(sub, { recursive: true });
  writeFileSync(join(session, 'sess-1.jsonl'), ''); writeFileSync(join(sub, 'agent-check-a.meta.json'), JSON.stringify({ agentType: 'sample-worker-check', finished: false }));
  writeFileSync(join(sub, 'agent-check-a.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'check-a', requestId: 'r1',
    message: { id: 'm1', model: 'm', role: 'assistant', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0, output_tokens: 5 } } }) + '\n');
  hook({ tool_name: 'Agent', tool_input: { subagent_type: 'x', prompt: PLACEHOLDER } });
  hook({ tool_name: 'SubagentHandback', agent_type: 'sample-worker-check', agent_id: 'check-a', session_id: 'sess-1', transcript_path: join(session, 'sess-1.jsonl'), tool_input: { message: checkReport(true) } });
  assert.equal(JSON.parse(readFileSync(join(team, DISPATCH_LOG), 'utf8').trim().split('\n').at(-1)).harnessTokens, 4010, 'the hook reads the agent\'s transcript with the meter');
  assert.equal(hook('{broken').status, 2);
  assert.equal(hook({ tool_name: 'Read', tool_input: {} }).status, 0);
});

test('a closed run admits nothing: next reports it, and a late hand-back is kept without reopening dispatch', () => {
  const r = rig(); r.step('exec-a', execReport());
  const check = r.next(); assert.equal(r.main(check).decision, 'allow');
  r.events.push({ type: 'closed' });
  assert.equal(r.next().action, 'closed');
  const again = decideDispatch({ input: { tool_name: 'Agent', tool_input: { subagent_type: 'x', prompt: PLACEHOLDER } }, launch: launchRecord(), events: r.events });
  assert.equal(again.decision, 'deny'); assert.match(again.reason, /closed/); assert.equal(again.event, undefined);
  const late = r.back('sample-worker-check', 'check-a', checkReport(false));
  assert.equal(late.decision, 'allow'); assert.equal(late.event.type, 'returned', 'the hand-back is evidence and is recorded');
  assert.equal(r.next().action, 'closed', 'a failed check after close does not start a retry');
  assert.equal(decideDispatch({ input: { tool_name: 'SendMessage', tool_input: { to: 'x', message: PLACEHOLDER } }, launch: launchRecord(), events: r.events }).decision, 'deny');
  const summary = runSummary({ launch: launchRecord(), events: r.events });
  assert.equal(summary.closed, true); assert.equal(summary.tickets[0].checkAgentId, 'check-a');
});

test('the gate admits nothing once the run no longer holds the product lease', () => {
  const r = rig(), input = { tool_name: 'Agent', tool_input: { subagent_type: 'x', prompt: PLACEHOLDER } };
  const lost = decideDispatch({ input, launch: launchRecord(), events: r.events, leaseHeld: false });
  assert.equal(lost.decision, 'deny'); assert.match(lost.reason, /lease/); assert.equal(lost.event, undefined);
  assert.equal(decideDispatch({ input, launch: launchRecord(), events: r.events, leaseHeld: true }).decision, 'allow');
  assert.equal(decideDispatch({ input: { tool_name: 'SubagentHandback', agent_type: 'sample-worker-exec', agent_id: 'a', tool_input: { message: 'x' } }, launch: launchRecord(), events: r.events, leaseHeld: false }).decision, 'allow');
});

test('the same invocation delivered twice is admitted once and answered the same way', () => {
  const r = rig(), input = { tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'x', prompt: PLACEHOLDER } };
  const first = decideDispatch({ input, launch: launchRecord(), events: r.events }); r.events.push(first.event);
  assert.equal(first.event.toolUseId, 'toolu_1');
  const repeat = decideDispatch({ input, launch: launchRecord(), events: r.events });
  assert.equal(repeat.decision, 'allow'); assert.equal(repeat.event, undefined, 'no second admission'); assert.deepEqual(repeat.updatedInput, first.updatedInput);
  assert.equal(decideDispatch({ input: { ...input, tool_use_id: 'toolu_2' }, launch: launchRecord(), events: r.events }).decision, 'deny', 'another invocation while the call is out');
});

test('two hook processes that overlap admit one call: the decision and its record are taken under one lock', async t => {
  const team = realpathSync(mkdtempSync(join(tmpdir(), 'rw-dispatch-race-'))); t.after(() => rmSync(team, { recursive: true, force: true }));
  mkdirSync(join(team, '.claude')); writeFileSync(join(team, 'rw-launch.json'), JSON.stringify(launchRecord()));
  // Test-only shim: each hook process pauses just before it records its admission, so the two decisions overlap.
  const shim = join(team, 'slow-append.mjs');
  writeFileSync(shim, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const append = fs.appendFileSync;
fs.appendFileSync = function (path, ...rest) { if (String(path).endsWith('rw-dispatch.jsonl')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); return append(path, ...rest); };
syncBuiltinESMExports();`);
  const start = id => new Promise(resolve => { const child = spawn(process.execPath, ['--import', shim, HOOK], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: team } });
    child.on('close', code => resolve(code)); child.stdin.end(JSON.stringify({ tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: 'x', prompt: PLACEHOLDER } })); });
  const codes = await Promise.all([start('toolu_a'), start('toolu_b')]);
  const admitted = readFileSync(join(team, DISPATCH_LOG), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'dispatched');
  assert.equal(admitted.length, 1, 'one admission in the log'); assert.deepEqual(codes.sort(), [0, 2], 'one hook admits, the other refuses');
});

test('the dispatch lock is exclusive and is never taken over', t => {
  const team = realpathSync(mkdtempSync(join(tmpdir(), 'rw-dispatch-lock-'))); t.after(() => rmSync(team, { recursive: true, force: true }));
  mkdirSync(join(team, '.claude')); const lock = join(team, DISPATCH_LOCK);
  assert.equal(withDispatchLock(team, () => { assert.equal(existsSync(lock), true); return 'ran'; }), 'ran'); assert.equal(existsSync(lock), false, 'released after the work');
  assert.throws(() => withDispatchLock(team, () => { throw Error('work failed'); }), /work failed/); assert.equal(existsSync(lock), false, 'released when the work throws');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 'x' }));
  assert.throws(() => withDispatchLock(team, () => 'never', { waitMs: 60 }), error => error.code === 'DISPATCH_LOCKED' && /another process/.test(error.message));
  writeFileSync(lock, JSON.stringify({ pid: 2147483646, at: 'x' }));
  assert.throws(() => withDispatchLock(team, () => 'never', { waitMs: 60 }), error => error.code === 'DISPATCH_LOCKED' && /gone/.test(error.message), 'a dead holder\'s lock is for the operator');
  assert.equal(existsSync(lock), true);
});

test('a pass must be grounded as the count engine requires: no-op, comment-only and multi-line commands are no evidence', () => {
  const verdict = commandsRun => { const r = rig(); r.step('exec-a', execReport()); r.step('check-a', checkReport(true, { commandsRun })); const end = r.next(); return end.action === 'done' ? end.tickets[0].status : 'passed'; };
  const one = command => [{ command, exitCode: 0 }];
  for (const command of ['true', ':', 'exit 0', '  TRUE  ', 'echo all good', 'true # ran the suite', '# npm test', 'npm test\nnpm run lint'])
    assert.equal(verdict(one(command)), 'check-report-invalid', JSON.stringify(command));
  assert.equal(verdict([{ command: 'true', exitCode: 0 }, { command: 'echo done', exitCode: 0 }]), 'check-report-invalid', 'only no-ops');
  assert.equal(verdict(one('npm test')), 'passed');
  assert.equal(verdict(one('echo starting tests && npm test')), 'passed', 'a compound command that starts with echo is real evidence');
  assert.equal(verdict([{ command: 'echo start', exitCode: 0 }, { command: 'fvm flutter test', exitCode: 0 }]), 'passed', 'a real command next to a no-op');
  const r = rig(); r.step('exec-a', execReport()); r.step('check-a', checkReport(true, { commandsRun: one('true') }));
  assert.deepEqual(r.next().tickets.map(t => t.status), ['check-report-invalid', 'not-dispatched'], 'a rejected pass does not advance to the next ticket');
});

test('the gate and the count engine judge the same command evidence the same way', async () => {
  const ENGINE = fileURLToPath(new URL('../.claude/workflows/run-n-rounds.js', import.meta.url));
  const corpus = [['true'], [':'], ['exit 0'], ['echo ok'], ['true # note'], ['# only a comment'], ['npm test\nnpm run lint'], ['true', 'echo done'],
    ['npm test'], ['echo start && npm test'], ['echo start', 'fvm flutter test'], ['fvm dart format --set-exit-if-changed .', 'fvm flutter analyze', 'fvm flutter test']];
  for (const commands of corpus) {
    const commandsRun = commands.map(command => ({ command, exitCode: 0 }));
    const r = rig(); r.step('exec-a', execReport()); r.step('check-a', checkReport(true, { commandsRun }));
    const end = r.next(), gate = end.action === 'done' ? end.tickets[0].status === 'passed' : true;
    const { result } = await runWorkflow({ scriptPath: ENGINE, enforceSchema: false, args: { rounds: 1, date: '2026-11-16', nextLifecycleNumber: 1, executionMode: 'wrappers', budgetCeilingTokens: 100000,
      guardianAgentType: 'g', allowedAgentTypes: ['b', 'q', 'g'], plan: [{ ticket: 'T-1', agentType: 'b', brief: 'x', isCodeShipping: true, verifierAgentType: 'q' }] },
      agentImpl: makeAgentImpl({ verifier: () => ({ pass: true, staticPass: true, e2ePass: true, summary: 's', commandsRun, failures: [] }) }) });
    assert.equal(gate, result.results[0].verificationStatus === 'passed', JSON.stringify(commands));
  }
});
