import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, renameSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { digest, bytesDigest } from '../src/loop/contracts.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { createRetryStore, openRetryStore } from '../src/router-worker/retry-store.mjs';
import { createRetryRegistry, openRetryRegistry } from '../src/router-worker/retry-registry.mjs';

const rules = loadRetryRules(), ref = id => ({ id, digest: digest(id) });
const supported = Number(process.versions.node.split('.')[0]) >= 24;
const MODULE = fileURLToPath(new URL('../src/router-worker/retry-registry.mjs', import.meta.url));
const INSPECT = fileURLToPath(new URL('../scripts/inspect-router-worker-registry.mjs', import.meta.url));
const registryTest = (name, fn) => test(name, { skip: !supported && 'Node 24+ required', timeout: 10000 }, fn);
const stop = name => ({ eventId: name, type: 'stop', reason: 'operator-stop', evidenceRef: ref(name) });
function fixture(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rw-registry-'))); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'registry'), anchor = createRetryRegistry({ root, repoId: 'fixture-product', rules });
  const registry = openRetryRegistry({ anchor, rules });
  const path = ticketId => join(root, digest({ repoId: 'fixture-product', ticketId }).slice(7));
  return { temp, root, anchor, registry, path };
}

registryTest('one stable repo/ticket key reopens its existing store and checkpoints every acknowledged append', async t => {
  const f = fixture(t), created = await f.registry.register('US-08'); assert.equal(created.created, true);
  const ticket = await f.registry.openTicket('US-08');
  const first = ticket.read(), written = ticket.append({ expectedDigest: first.journal.digest, event: stop('stop-1') });
  assert.equal(written.checkpoint.eventCount, 1); assert.equal(written.checkpoint.lagging, false);
  assert.ok(!written.state.unresolved.includes('stable-ticket-store-binding'));
  assert.ok(written.state.unresolved.includes('whole-registry-rollback-protection'));
  ticket.close();
  const again = await openRetryRegistry({ anchor: f.anchor, rules }).register('US-08');
  assert.equal(again.created, false); assert.equal(again.storage.eventCount, 1);
  assert.deepEqual(again.state.stops, ['operator-stop']);
  const other = await f.registry.register('US-09'); assert.equal(other.storage.eventCount, 0);
  assert.notEqual(again.registry.bindingDigest, other.registry.bindingDigest);
});

registryTest('creation and opening require the separately pinned root anchor', async t => {
  const f = fixture(t), manifest = readFileSync(join(f.root, 'registry.json'));
  assert.throws(() => createRetryRegistry({ root: f.root, repoId: 'fixture-product', rules }), error => error.code === 'EEXIST');
  assert.deepEqual(readFileSync(join(f.root, 'registry.json')), manifest);
  const other = createRetryRegistry({ root: join(f.temp, 'other'), repoId: 'fixture-product', rules });
  assert.throws(() => openRetryRegistry({ anchor: { ...other, root: f.root }, rules }), /anchor/);
  assert.throws(() => openRetryRegistry({ anchor: { ...f.anchor, repoId: 'different' }, rules }), /anchor/);
  const changed = structuredClone(rules); changed.sourceDigests['agents/pm.md'] = digest('changed');
  assert.throws(() => openRetryRegistry({ anchor: f.anchor, rules: changed }), /anchor/);
});

registryTest('deleting a ticket directory cannot reset it because its root-level claim survives', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  rmSync(f.path('US-08'), { recursive: true });
  await assert.rejects(f.registry.register('US-08'));
  assert.equal(readdirSync(f.root).filter(name => name.endsWith('.claim.json')).length, 1);
});

registryTest('deleted bindings or a missing journal never trigger automatic recreation', async t => {
  for (const name of ['binding.json', 'journal.rw-retries.sqlite']) {
    const f = fixture(t); await f.registry.register('US-08'); rmSync(join(f.path('US-08'), name));
    const before = readdirSync(f.path('US-08')).sort(); await assert.rejects(f.registry.register('US-08'));
    assert.deepEqual(readdirSync(f.path('US-08')).sort(), before);
  }
});

registryTest('a fresh replacement database cannot be substituted for the registered store', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const filename = join(f.path('US-08'), 'journal.rw-retries.sqlite'); renameSync(filename, filename + '.old');
  await createRetryStore({ filename, ticketId: 'US-08', rules });
  await assert.rejects(f.registry.openTicket('US-08'), error => error.code === 'REGISTRY_BINDING_MISMATCH');
});

registryTest('restoring an older valid database in place is rejected by retained checkpoints', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const filename = join(f.path('US-08'), 'journal.rw-retries.sqlite'), old = readFileSync(filename);
  const ticket = await f.registry.openTicket('US-08'); ticket.append({ expectedDigest: ticket.read().journal.digest, event: stop('new-history') }); ticket.close();
  writeFileSync(filename, old);
  await assert.rejects(openRetryRegistry({ anchor: f.anchor, rules }).openTicket('US-08'), error => error.code === 'REGISTRY_CHECKPOINT_MISMATCH');
});

registryTest('unacknowledged store progress blocks fresh work until identical replay seals its checkpoint', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const store = await openRetryStore({ filename: join(f.path('US-08'), 'journal.rw-retries.sqlite'), ticketId: 'US-08', rules });
  const before = store.read().journal.digest; store.append({ expectedDigest: before, event: stop('lost-response') }); store.close();
  const ticket = await f.registry.openTicket('US-08'); t.after(() => ticket.close());
  const pending = ticket.read(); assert.equal(pending.checkpoint.lagging, true);
  assert.throws(() => ticket.append({ expectedDigest: pending.journal.digest, event: stop('new-event') }), error => error.code === 'REGISTRY_CHECKPOINT_PENDING');
  const replay = ticket.append({ expectedDigest: before, event: stop('lost-response') });
  assert.equal(replay.applied, false); assert.equal(replay.checkpoint.lagging, false); assert.equal(replay.storage.eventCount, 1);
});

registryTest('explicit checkpointing requires the current digest and never changes journal counters', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const store = await openRetryStore({ filename: join(f.path('US-08'), 'journal.rw-retries.sqlite'), ticketId: 'US-08', rules });
  store.append({ expectedDigest: store.read().journal.digest, event: stop('unacknowledged') }); store.close();
  const ticket = await f.registry.openTicket('US-08'), before = ticket.read(); t.after(() => ticket.close());
  assert.throws(() => ticket.checkpoint({ expectedDigest: digest('wrong') }), error => error.code === 'STALE_RETRY_JOURNAL');
  const after = ticket.checkpoint({ expectedDigest: before.journal.digest });
  assert.deepEqual(after.journal, before.journal); assert.equal(after.checkpoint.lagging, false);
});

registryTest('read-only handles cannot append or repair a missing checkpoint', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const ticket = await f.registry.openTicket('US-08', { readOnly: true }); t.after(() => ticket.close());
  const before = ticket.read();
  assert.throws(() => ticket.append({ expectedDigest: before.journal.digest, event: stop('write') }), error => error.code === 'RETRY_STORE_READ_ONLY');
  assert.throws(() => ticket.checkpoint({ expectedDigest: before.journal.digest }), error => error.code === 'RETRY_STORE_READ_ONLY');
  assert.deepEqual(ticket.read().journal, before.journal);
});

registryTest('path aliases and corrupted checkpoints fail closed', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const checkpoint = join(f.path('US-08'), 'checkpoints/000.json'), record = JSON.parse(readFileSync(checkpoint, 'utf8'));
  record.journalDigest = digest('forged'); const { digest: ignored, ...body } = record; record.digest = digest(body);
  writeFileSync(checkpoint, JSON.stringify(record));
  await assert.rejects(f.registry.openTicket('US-08'), error => error.code === 'REGISTRY_CHECKPOINT_MISMATCH');
  const alias = join(f.temp, 'alias'); symlinkSync(f.root, alias);
  assert.throws(() => openRetryRegistry({ anchor: { ...f.anchor, root: alias }, rules }));
});

registryTest('anchored registry CLI inspects without writes and refuses replaced anchors or checkpoint rollback', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const anchorPath = join(f.temp, 'anchor.json'), bytes = JSON.stringify(f.anchor);
  writeFileSync(anchorPath, bytes, { mode: 0o600 });
  const run = (hash = bytesDigest(bytes), ticket = 'US-08') => spawnSync(process.execPath, [INSPECT, anchorPath, hash, ticket], { encoding: 'utf8', timeout: 5000 });
  const filename = join(f.path('US-08'), 'journal.rw-retries.sqlite'), before = readFileSync(filename);
  const inspected = run(); assert.equal(inspected.status, 0, inspected.stderr);
  const output = JSON.parse(inspected.stdout);
  assert.equal(output.stage, 'offline-registry-inspection'); assert.equal(output.registry.anchored, true);
  assert.equal(output.state.launchable, false); assert.equal(output.storage.readOnly, true);
  assert.deepEqual(readFileSync(filename), before);
  const entries = readdirSync(f.root).sort(), missing = run(bytesDigest(bytes), 'missing');
  assert.equal(missing.status, 2); assert.equal(missing.stdout, ''); assert.deepEqual(readdirSync(f.root).sort(), entries);
  const wrong = run(bytesDigest('wrong')); assert.equal(wrong.status, 2); assert.equal(wrong.stdout, '');
  assert.equal(JSON.parse(wrong.stderr).errors[0].code, 'REGISTRY_ANCHOR_MISMATCH');
  writeFileSync(anchorPath, JSON.stringify({ ...f.anchor, registryId: 'replacement' }));
  assert.equal(run().status, 2); writeFileSync(anchorPath, bytes);
  const ticket = await f.registry.openTicket('US-08'); ticket.append({ expectedDigest: ticket.read().journal.digest, event: stop('new') }); ticket.close();
  writeFileSync(filename, before);
  const rolledBack = run(); assert.equal(rolledBack.status, 2); assert.equal(rolledBack.stdout, '');
  assert.match(rolledBack.stderr, /REGISTRY_CHECKPOINT_MISMATCH/);
});

test('registry CLI requires all arguments and never initializes a missing anchor', t => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rw-registry-cli-'))); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const missingArgs = spawnSync(process.execPath, [INSPECT], { encoding: 'utf8', timeout: 5000 });
  assert.equal(missingArgs.status, 1); assert.equal(missingArgs.stdout, '');
  const missingFile = spawnSync(process.execPath, [INSPECT, join(temp, 'missing.json'), bytesDigest('missing'), 'US-08'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(missingFile.status, 2); assert.equal(missingFile.stdout, ''); assert.deepEqual(readdirSync(temp), []);
});

test('unsupported runtime capability fails before claiming a registry or ticket path', t => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rw-registry-cap-'))); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const code = `import {createRetryRegistry} from ${JSON.stringify(MODULE)};
    Object.defineProperty(process.versions,'node',{value:'22.0.0'});
    try{createRetryRegistry({root:process.argv[1],repoId:'fixture',rules:JSON.parse(process.argv[2])});process.exitCode=1;}
    catch(e){console.log(e.code);}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, join(temp, 'registry'), JSON.stringify(rules)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0); assert.match(child.stdout, /CAPABILITY_MISSING/); assert.deepEqual(readdirSync(temp), []);
});

registryTest('two real registry clients cannot acknowledge conflicting appends from the same version', async t => {
  const f = fixture(t); await f.registry.register('US-08');
  const ticket = await f.registry.openTicket('US-08'), expectedDigest = ticket.read().journal.digest; ticket.close();
  const code = `import {openRetryRegistry} from ${JSON.stringify(MODULE)};
    const [anchor,rules,expectedDigest,event]=process.argv.slice(1).map(JSON.parse);
    const t=await openRetryRegistry({anchor,rules}).openTicket('US-08');console.log('ready');
    process.stdin.once('data',()=>{try{const r=t.append({expectedDigest,event});console.log(r.applied?'applied':'replay');}
    catch(e){console.log(e.code)}finally{t.close();}});`;
  const children = [1, 2].map(n => spawn(process.execPath, ['--input-type=module', '-e', code,
    JSON.stringify(f.anchor), JSON.stringify(rules), JSON.stringify(expectedDigest), JSON.stringify(stop(`race-${n}`))], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); }));
  const output = ['', ''];
  await Promise.all(children.map((child, i) => new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => { output[i] += bytes; if (output[i].includes('ready\n')) resolve(); });
    child.once('error', reject); child.once('exit', () => { if (!output[i].includes('ready\n')) reject(Error('Child exited before ready')); });
  })));
  const exits = children.map(child => once(child, 'exit')); children.forEach(child => child.stdin.end('go')); await Promise.all(exits);
  assert.equal(output.filter(text => text.includes('applied')).length, 1);
  assert.equal(output.filter(text => /STALE_RETRY_JOURNAL|REGISTRY_CHECKPOINT_PENDING/.test(text)).length, 1);
  const reopened = await f.registry.openTicket('US-08');
  assert.equal(reopened.read().storage.eventCount, 1); assert.equal(reopened.read().checkpoint.lagging, false); reopened.close();
});
