// The batch runbook was split from its reference: no section of the single file it was may be lost,
// and every link from the runbook into the reference names a section there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../docs/design/router-worker/${path}`, import.meta.url), 'utf8');
const headings = text => text.split('\n').filter(line => /^#{2,3} /.test(line)).map(line => line.replace(/^#+ /, ''));
const slug = heading => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

const TITLES = [
  'The order of a batch', 'What the PM writes', 'What "before" does, in order', 'After', 'The workers\' shell', 'Moves and deletions',
  'Settle', 'Commit', 'Review triggers', 'Review state and brief', 'Review verdict, commit gate and escalation', 'Resolve',
  'Periodic review', 'The lock of a command', 'When the kit will not commit a batch', 'Commit hooks', 'What these commands trust',
  'Abort', 'What decides the limits', 'Start as is', 'Resuming left work', 'Refusals (`BATCH_REFUSED`)', 'Not covered',
];

test('every section of the batch document before its split is in the runbook or the reference', () => {
  const held = new Set([...headings(read('batch.md')), ...headings(read('batch-reference.md'))]);
  assert.deepEqual(TITLES.filter(title => !held.has(title)), []);
});

test('every link from the runbook into the reference names a section of the reference', () => {
  const anchors = new Set(headings(read('batch-reference.md')).map(slug));
  const links = [...read('batch.md').matchAll(/\]\(batch-reference\.md#([^)]+)\)/g)].map(match => match[1]);
  assert.ok(links.length > 0);
  assert.deepEqual(links.filter(anchor => !anchors.has(anchor)), []);
});
