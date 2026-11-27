// What one Router/Worker dispatch carries, in bytes by role, each against a ceiling kept a little above its measured size.
// Each figure is measured on its own: the args hold the briefs and the open record holds the args, so none is a sum of
// the others. The engine's own wrapping of a brief at dispatch is not counted: it is the workflow's text, not the kit's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { live, ticket, batchOf, runBatch } from './fixtures/router-worker/review.mjs';

// Ceilings in bytes, by fixture and role, about 10% above the size measured when each was set. Raise one only with the reason the dispatch grew.
const CEILINGS = {
  bare: { exec: 3700, check: 3600, args: 8400, record: 17200 },
  package: { exec: 4400, check: 4300, args: 9900, record: 19300 },
  resumed: { exec: 4000, check: 3600, args: 8700, record: 18000 },
  reviewed: { exec: 3700, check: 3600, args: 8400, record: 17200, reviewer: 6400 },
};
const ROLES = ['exec', 'check', 'args', 'record', 'reviewer'];
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
// The temporary folder's name differs by machine; it is counted as a fixed placeholder.
function measure(f, record, id, reviewerBrief) {
  const size = text => Buffer.byteLength(text.replaceAll(f.base, '<base>')), item = record.args.plan.find(entry => entry.ticket === id);
  return { exec: size(item.brief), check: size(item.verifierBrief), args: size(JSON.stringify(record.args)), record: size(JSON.stringify(record, null, 2)), ...(reviewerBrief ? { reviewer: size(reviewerBrief) } : {}) };
}
const overCeiling = (measured, ceiling) => Object.entries(measured).filter(([role, bytes]) => bytes > ceiling[role]).map(([role, bytes]) => `${role} ${bytes} > ${ceiling[role]}`);
const opened = async (f, batch) => { const record = await f.before(batch); assert.equal(record.errors, undefined, JSON.stringify(record.errors)); return record; };

const FIXTURES = {
  bare: async t => { const f = live(t); return measure(f, await opened(f, batchOf(ticket('T-1', ['src/list/a.js']))), 'T-1'); },
  package: async t => {
    const f = live(t);
    write(f.product, 'quarry/README.md', '# quarry\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'packages');
    write(f.root, 'profiles/stack/quarry.md', '# quarry\nIndent with tabs. Every exported function has a test beside it.\n');
    write(f.root, 'profiles/packages.json', JSON.stringify({ schemaVersion: 1, packages: [{ name: 'quarry', dir: 'quarry', conventions: 'profiles/stack/quarry.md', interfaces: ['quarry/api/**'] }] }));
    return measure(f, await opened(f, batchOf(ticket('T-1', ['quarry/src/**'], { package: 'quarry', expectedPaths: ['quarry/src/a.js'] }))), 'T-1');
  },
  resumed: async t => {
    const f = live(t);
    write(f.product, 'src/list/a.js', 'a\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
    write(f.product, 'src/list/a.js', 'a\nresumed\n'); write(f.product, 'src/list/new.js', 'new\n'); git(f.product, 'add', '-A', '-N');
    write(f.root, 'handoff/T-1/left.patch', git(f.product, 'diff', '--binary', 'HEAD')); git(f.product, 'reset', '-q', '--hard'); git(f.product, 'clean', '-q', '-fd');
    return measure(f, await opened(f, batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' }))), 'T-1');
  },
  reviewed: async t => {
    const f = live(t), { open } = await runBatch(f, [ticket('T-1', ['src/authz.js'])], { 'src/authz.js': 'export const can = () => true;\n' });
    const made = f.brief('security');
    assert.equal(made.errors, undefined, JSON.stringify(made.errors));
    return measure(f, open, 'T-1', made.brief);
  },
};

test('each role of a dispatch stays under its ceiling, on a bare ticket, a packaged one, a resumed one and one flagged for review', async t => {
  const measured = {};
  for (const [name, build] of Object.entries(FIXTURES)) measured[name] = await build(t);
  t.diagnostic(`bytes by role: ${['fixture', ...ROLES].join(' | ')}`);
  for (const [name, row] of Object.entries(measured)) t.diagnostic(`${[name, ...ROLES.map(role => row[role] === undefined ? '-' : `${row[role]}/${CEILINGS[name][role]}`)].join(' | ')}`);
  assert.deepEqual(Object.fromEntries(Object.entries(measured).map(([name, row]) => [name, overCeiling(row, CEILINGS[name])])), { bare: [], package: [], resumed: [], reviewed: [] });
});

test('a ticket written far longer than the bare one is reported over the bare ceilings', async t => {
  const f = live(t), acceptance = Array.from({ length: 30 }, (_, i) => `Criterion ${i}: ${'the list keeps its order when a tag is renamed, removed or added again. '.repeat(2)}`);
  const over = overCeiling(measure(f, await opened(f, batchOf(ticket('T-1', ['src/list/a.js'], { acceptance }))), 'T-1'), CEILINGS.bare);
  t.diagnostic(`over: ${over.join(', ')}`);
  assert.deepEqual(over.map(entry => entry.split(' ')[0]), ['exec', 'check', 'args', 'record']);
});
