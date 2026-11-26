// Review finding R23-01: a commit holds the bytes "after" saw, not what a commit hook made of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { afterBatch } from '../src/router-worker/batch-close.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { git, checksRan } from './fixtures/router-worker/standing-team.mjs';
import { live, ticket, batchOf, refusal } from './fixtures/router-worker/review.mjs';

const write = (root, path, text, mode) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text, mode ? { mode } : undefined); };

async function closedWith(t, hook) {
  const f = live(t);
  write(f.product, 'src/app.js', 'x = 1\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  if (hook) write(f.product, '.git/hooks/pre-commit', hook, 0o755);
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/app.js'])), verificationCommands: f.commands });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const worker = () => { writeFileSync(join(f.product, 'src/app.js'), 'x = 2\n'); return { outcome: 'done', progress: true, filesTouched: ['src/app.js'], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'set x' }; };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  checksRan(f.root, open);
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.commits.length, 1);
  return f;
}

test('a commit hook that rewrites and stages a ticket\'s file stops the commit, and says so', async t => {
  const f = await closedWith(t, '#!/bin/sh\necho "x = 999" > src/app.js\ngit add src/app.js\n');
  assert.match(refusal(f.commit())?.reason ?? '', /The commit of ticket T-1 \(\w+\) holds other bytes than after saw in src\/app\.js; a commit hook may have rewritten them/);
});

test('a commit hook that leaves the bytes alone commits as before', async t => {
  const f = await closedWith(t, '#!/bin/sh\nexit 0\n');
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors));
  assert.equal(git(f.product, 'show', 'HEAD:src/app.js'), 'x = 2\n');
});

test('a batch whose commits are all held is not put in review: no verdict could release them', async t => {
  const f = live(t);
  write(f.product, 'src/authz.js', 'a = 1\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/authz.js'])), verificationCommands: f.commands });
  const worker = () => { writeFileSync(join(f.product, 'src/authz.js'), 'a = 2\n'); return { outcome: 'done', progress: true, filesTouched: ['src/authz.js'], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'ok' }; };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  git(f.product, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.holdAll, true); assert.deepEqual(closed.reviews, {}); assert.equal(f.state(), 'closed', 'the reviewers are not let in');
});
