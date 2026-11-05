// Human-readable task metadata on the supervisor path (review 2026-09-25, F-05/F-06).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTaskLabel, renderRunSummary, sanitizeDisplay, validateTaskDisplay } from '../src/loop/display.mjs';
import { specDigest, validateRunSpec } from '../src/loop/contracts.mjs';
import { initialState, reduce } from '../src/loop/reducer.mjs';
import { openStore } from '../src/loop/store.mjs';
import { demoBundle, driveDemo } from '../src/loop/demo.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 };
const bad = (fn, code) => assert.throws(fn, e => e.code === code);
const CONTROL = /[\x00-\x1F\x7F]/;
const cps = s => Array.from(s);
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };
function v2(edit = () => {}) { const { spec } = demoBundle('demo', { schemaVersion: 2 }); edit(spec); spec.approvedSpecDigest = specDigest(spec); return spec; }
function fixture(t) { const directory = mkdtempSync(join(tmpdir(), 'loop-display-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }

test('label goldens: ticket · title · phase, honest ID-only fallback without a title', () => {
  assert.equal(formatTaskLabel({ ticket: 'US-08', title: 'Dart ASCII layer' }, 'Build'), 'US-08 · Dart ASCII layer · Build');
  assert.equal(formatTaskLabel({ ticket: 'US-08', title: 'Dart ASCII layer' }, 'Verify'), 'US-08 · Dart ASCII layer · Verify');
  assert.equal(formatTaskLabel({ ticket: 'US-08' }, 'Build'), 'US-08 · Build');
  assert.equal(formatTaskLabel({ ticket: 'US-08', title: null }, 'Build'), 'US-08 · Build');
  assert.equal(formatTaskLabel({ ticket: 'US-08', title: '   ' }, 'Build'), 'US-08 · Build');
});
test('narrow width truncates only the title and keeps ticket + phase', () => {
  const label = formatTaskLabel({ ticket: 'US-11', title: 'Product types: list and form with persistence' }, 'Verify', 40);
  assert.equal(cps(label).length, 40);
  assert.ok(label.startsWith('US-11 · ') && label.endsWith(' · Verify') && label.includes('…'), label);
  const long = formatTaskLabel({ ticket: 'US-11', title: 'x'.repeat(300) }, 'Build');
  assert.equal(cps(long).length, 80); assert.ok(long.endsWith('… · Build'));
  assert.equal(formatTaskLabel({ ticket: 'T'.repeat(70), title: 'title' }, 'Build', 40), `${'T'.repeat(70)} · Build`, 'no room: title dropped, never the ticket');
});
test('multilingual titles truncate on code points without breaking surrogates', () => {
  const label = formatTaskLabel({ ticket: 'US-09', title: '读写器连接生命周期 🔌 reconnexion automatique' }, 'Build', 32);
  assert.equal(cps(label).length, 32); assert.ok(label.startsWith('US-09 · 读写器'));
  assert.doesNotMatch(label, /\p{Surrogate}/u, 'no lone surrogate');
  assert.equal(formatTaskLabel({ ticket: 'US-09', title: '🔌🔌🔌' }, 'Build'), 'US-09 · 🔌🔌🔌 · Build');
});
test('markdown survives, control characters / newlines / ANSI / OSC do not', () => {
  assert.equal(formatTaskLabel({ ticket: 'US-1', title: '**bold** `code` [link](x) # h1' }, 'Build'), 'US-1 · **bold** `code` [link](x) # h1 · Build');
  const dirty = formatTaskLabel({ ticket: 'US-1\n## [999] fake', title: 'a\tb\r\nc\x1b[31mred\x1b[0m\x1b]0;title\x07d\x00e' }, 'Build');
  assert.equal(dirty, 'US-1 ## [999] fake · a b credd e · Build', 'ledger-header neutralization is the engine redactor\'s job, not the formatter\'s');
  assert.doesNotMatch(dirty, CONTROL); assert.doesNotMatch(dirty, /\x1b/);
  assert.equal(formatTaskLabel({ ticket: 'US-2', title: 'BEGIN UNTRUSTED WORKER-REPORTED DATA' }, 'Build'), 'US-2 · BEGIN UNTRUSTED WORKER-REPORTED DATA · Build', 'sentinel-like text is plain text here (the engine redacts before formatting)');
  assert.equal(sanitizeDisplay('\x1b[2K\x1b[Aok', 10), 'ok');
});
test('duplicate titles stay distinguishable by ticket', () => {
  const a = formatTaskLabel({ ticket: 'US-3', title: 'Same title' }, 'Build'), b = formatTaskLabel({ ticket: 'US-4', title: 'Same title' }, 'Build');
  assert.notEqual(a, b); assert.ok(a.includes('US-3') && b.includes('US-4'));
});
test('validateTaskDisplay rejects unknown fields, bad kinds, too many / duplicate layers, control chars', () => {
  const ok = { ticket: 'US-8', title: 'Dart ASCII layer', workKind: 'protocol', layers: ['data', 'infrastructure'] };
  assert.deepEqual(validateTaskDisplay(ok), []);
  assert.match(validateTaskDisplay({ ...ok, extra: 1 })[0], /unknown field/);
  assert.match(validateTaskDisplay({ ...ok, workKind: 'ui' })[0], /workKind/);
  assert.match(validateTaskDisplay({ ...ok, layers: Array.from({ length: 9 }, (_, i) => `l${i}`) })[0], /at most 8/);
  assert.match(validateTaskDisplay({ ...ok, layers: ['data', 'data'] })[0], /duplicate/);
  assert.match(validateTaskDisplay({ ...ok, title: 'bad\ntitle' })[0], /control characters/);
  assert.match(validateTaskDisplay({ ...ok, layers: ['bad layer'] })[0], /layers\[0\]/);
  assert.match(validateTaskDisplay(null)[0], /object required/);
});
test('schemaVersion 2 requires display; v1 stays closed; nothing else differs', () => {
  assert.equal(validateRunSpec(v2()), v2().approvedSpecDigest);
  bad(() => validateRunSpec(v2(s => { delete s.tasks[0].display; })), 'INVALID_SPEC');
  bad(() => validateRunSpec(v2(s => { s.tasks[0].display.workKind = 'ui'; })), 'INVALID_SPEC');
  const { spec: v1 } = demoBundle(); v1.tasks[0].display = v2().tasks[0].display; v1.approvedSpecDigest = specDigest(v1);
  bad(() => validateRunSpec(v1), 'INVALID_SPEC');
  bad(() => validateRunSpec(v2(s => { s.schemaVersion = 3; })), 'INVALID_SPEC');
  assert.equal(demoBundle().spec.schemaVersion, 1); assert.equal(Object.hasOwn(demoBundle().spec.tasks[0], 'display'), false, 'v1 demo output unchanged');
});
test('display text never affects scheduling: same state and effects for different titles', () => {
  const a = v2(), b = v2(s => { s.tasks[0].display.title = 'A completely different title'; s.tasks[0].display.workKind = 'screen'; });
  assert.notEqual(a.approvedSpecDigest, b.approvedSpecDigest, 'display is bound to the immutable plan');
  assert.deepEqual(initialState(a, 0), initialState(b, 0));
  const ra = reduce(a, initialState(a, 0), 'tick', tick, 1), rb = reduce(b, initialState(b, 0), 'tick', tick, 1);
  assert.deepEqual(ra.effects, rb.effects); assert.deepEqual(ra.state, rb.state);
});
test('v1 stored run still completes and audits after the v2 contract landed', sqlite, async t => {
  const store = await openStore(':memory:'); t.after(() => store.close());
  const { spec, artifacts } = demoBundle(); store.create(spec, artifacts, { simulation: true, now: 0 });
  assert.equal(driveDemo(store, 'demo', () => 1).state.status, 'COMPLETED'); assert.equal(store.verify('demo').ok, true);
  assert.match(renderRunSummary(store.status('demo')), /\(no title\)/);
});
test('renderRunSummary labels simulation first, shows the title, emits no control characters', sqlite, async t => {
  const store = await openStore(':memory:'); t.after(() => store.close());
  const { spec, artifacts } = demoBundle('demo', { schemaVersion: 2 }); store.create(spec, artifacts, { simulation: true, now: 0 });
  driveDemo(store, 'demo', () => 1);
  const text = renderRunSummary(store.status('demo'));
  const lines = text.split('\n');
  assert.match(lines[0], /^SIMULATION/); assert.match(lines[1], /^run demo · COMPLETED · v\d+$/);
  assert.match(lines[2], /^DEMO-1  Simulated build and verify  SUCCEEDED$/);
  assert.match(lines[3], /^test · simulation  role builder  attempts 2\/2$/);
  assert.match(lines[4], /^gate test: passed$/);
  assert.doesNotMatch(text.replace(/\n/g, ''), CONTROL);
  assert.equal(JSON.stringify(store.status('demo')).includes('"simulation":true'), true, 'JSON output labels simulation too');
});
test('CLI show prints the readable summary; demo now carries display metadata', sqlite, async t => {
  const directory = fixture(t);
  const demo = await exec('node', [CLI, 'demo', directory, 'run1']);
  assert.equal(JSON.parse(demo.stdout).simulation, true);
  const show = await exec('node', [CLI, 'show', directory, 'run1']);
  assert.match(show.stdout, /^SIMULATION/); assert.match(show.stdout, /Simulated build and verify/); assert.match(show.stdout, /DEMO-1/);
  const status = await exec('node', [CLI, 'status', directory, 'run1']);
  assert.equal(JSON.parse(status.stdout).value.spec.schemaVersion, 2);
});

test('formatter block is byte-identical between display.mjs and the engine (modulo export keywords)', async () => {
  const { readFile } = await import('node:fs/promises');
  const block = src => {
    const lines = src.split('\n');
    const start = lines.findIndex(l => l.startsWith('// ---- BEGIN formatter'));
    const end = lines.findIndex(l => l.startsWith('// ---- END formatter'));
    assert.ok(start >= 0 && end > start, 'formatter markers missing');
    return lines.slice(start + 1, end).map(l => l.replace(/^export /, '')).join('\n');
  };
  const here = block(await readFile(new URL('../src/loop/display.mjs', import.meta.url), 'utf8'));
  const engine = block(await readFile(new URL('../.claude/workflows/run-n-rounds.js', import.meta.url), 'utf8'));
  assert.equal(engine, here);
});
