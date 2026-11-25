// ADR 0010, amendment of 2026-11-25: a ticket names the verification commands its workers run, among the batch's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { live, ticket, batchOf, refusal, COMMANDS } from './fixtures/router-worker/review.mjs';

const taskData = brief => JSON.parse(brief.split('\n').find(line => line.startsWith('{"assignmentId"')));

test('a ticket that names a subset of the batch\'s commands gets only those in its briefs; the others keep the whole list', async t => {
  const f = live(t);
  const open = await f.before(batchOf(ticket('T-1', ['docs/a.md'], { verificationCommands: ['pwd'] }), ticket('T-2', ['src/b.js'])));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const [docs, code] = open.args.plan;
  for (const brief of [docs.brief, docs.verifierBrief]) assert.deepEqual(taskData(brief).verificationCommands, ['pwd']);
  for (const brief of [code.brief, code.verifierBrief]) assert.deepEqual(taskData(brief).verificationCommands, COMMANDS);
  assert.deepEqual(open.tickets[0].verificationCommands, ['pwd']); assert.equal(open.tickets[1].verificationCommands, undefined);
  assert.deepEqual(open.verificationCommands, COMMANDS, 'the batch list, which the hook allows, is unchanged');
});

test('a ticket\'s commands must be a non-empty list of the batch\'s own, each named once', async t => {
  const f = live(t);
  for (const commands of [[], ['npm test'], ['pwd', 'pwd'], 'pwd'])
    assert.match(refusal(await f.before(batchOf(ticket('T-1', ['docs/a.md'], { verificationCommands: commands }))))?.reason ?? '',
      /Ticket T-1: verificationCommands must list 1 or more of the batch's verification commands, each once/, JSON.stringify(commands));
});
