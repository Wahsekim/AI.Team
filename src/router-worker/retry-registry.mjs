import { mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, rmSync, linkSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, parseJSON, fields, id, requireThat } from '../loop/contracts.mjs';
import { createRetryJournal } from './retries.mjs';
import { createRetryStore, openRetryStore } from './retry-store.mjs';

const expect = (condition, message, code = 'INVALID_RETRY_REGISTRY') => requireThat(condition, code, message);
const copy = value => parseJSON(canonical(value));
const envelope = body => ({ ...body, digest: digest(body) });
const same = (a, b) => canonical(a) === canonical(b);
const capability = () => expect(Number(process.versions.node.split('.')[0]) >= 24, 'Retry registry requires Node 24+', 'CAPABILITY_MISSING');
function identity(path, directory = false) {
  const stat = lstatSync(path, { bigint: true });
  expect(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
    && (stat.mode & 0o077n) === 0n, 'Private non-symlink registry paths required');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function read(path) {
  identity(path);
  expect(lstatSync(path).size <= 1024 * 1024, 'Registry record exceeds byte limit');
  const value = parseJSON(readFileSync(path, 'utf8')), { digest: expected, ...body } = value;
  expect(expected === digest(body), 'Registry record digest mismatch'); return value;
}
function publish(path, value, stagingRoot = dirname(path)) {
  const temp = mkdtempSync(join(stagingRoot, '.record-'));
  try {
    const payload = join(temp, 'record.json');
    writeFileSync(payload, canonical(value) + '\n', { mode: 0o600, flag: 'wx' }); linkSync(payload, path);
  } catch (error) {
    if (error.code !== 'EEXIST' || !same(read(path), value)) throw error;
  } finally { rmSync(temp, { force: true, recursive: true }); }
}
function rootPath(root) {
  expect(typeof root === 'string' && isAbsolute(root) && resolve(root) === root
    && realpathSync(dirname(root)) === dirname(root), 'Canonical absolute registry path required');
  expect(!root.split('/').some(part => ['.git', '.claude'].includes(part)), 'Registry cannot live inside Git metadata or a runtime registry');
}

export function createRetryRegistry({ root, repoId, rules }) {
  capability();
  rootPath(root); id(repoId);
  createRetryJournal({ ticketId: 'registry-validation', rules });
  mkdirSync(root, { mode: 0o700 });
  const manifest = envelope({ schemaVersion: 1, kind: 'offline-retry-registry', registryId: randomUUID(), repoId, rulesDigest: digest(rules) });
  // The directory is the creation claim. An interrupted creation is never silently reset.
  publish(join(root, 'registry.json'), manifest);
  return { schemaVersion: 1, root, registryId: manifest.registryId, repoId, rulesDigest: manifest.rulesDigest,
    rootIdentity: identity(root, true), manifestDigest: manifest.digest };
}

export function openRetryRegistry({ anchor: suppliedAnchor, rules: suppliedRules }) {
  capability();
  const anchor = copy(suppliedAnchor), rules = copy(suppliedRules);
  fields(anchor, ['schemaVersion', 'root', 'registryId', 'repoId', 'rulesDigest', 'rootIdentity', 'manifestDigest'], 'Registry anchor');
  rootPath(anchor.root); id(anchor.repoId); createRetryJournal({ ticketId: 'registry-validation', rules });
  function check() {
    expect(anchor.schemaVersion === 1 && anchor.rulesDigest === digest(rules) && realpathSync(anchor.root) === anchor.root
      && same(identity(anchor.root, true), anchor.rootIdentity), 'Registry anchor/root/rules changed', 'REGISTRY_ANCHOR_MISMATCH');
    const manifest = read(join(anchor.root, 'registry.json'));
    fields(manifest, ['schemaVersion', 'kind', 'registryId', 'repoId', 'rulesDigest', 'digest'], 'Registry manifest');
    expect(manifest.schemaVersion === 1 && manifest.kind === 'offline-retry-registry'
      && manifest.digest === anchor.manifestDigest && manifest.registryId === anchor.registryId
      && manifest.repoId === anchor.repoId && manifest.rulesDigest === anchor.rulesDigest,
    'Registry manifest differs from the separately supplied anchor', 'REGISTRY_ANCHOR_MISMATCH');
  }
  check();
  function paths(ticketId) {
    id(ticketId);
    const key = digest({ repoId: anchor.repoId, ticketId }).slice(7), directory = join(anchor.root, key);
    return { directory, claim: join(anchor.root, `${key}.claim.json`), binding: join(directory, 'binding.json'), store: join(directory, 'journal.rw-retries.sqlite'),
      checkpoints: join(directory, 'checkpoints') };
  }
  function binding(ticketId) {
    check(); const path = paths(ticketId); identity(path.directory, true); identity(path.checkpoints, true);
    const claim = read(path.claim);
    fields(claim, ['schemaVersion', 'registryId', 'repoId', 'ticketId', 'allocationId', 'digest'], 'Ticket claim');
    expect(claim.schemaVersion === 1 && claim.registryId === anchor.registryId && claim.repoId === anchor.repoId
      && claim.ticketId === ticketId && typeof claim.allocationId === 'string' && /^[a-f0-9-]{36}$/.test(claim.allocationId), 'Invalid ticket claim');
    const record = read(path.binding);
    fields(record, ['schemaVersion', 'registryId', 'repoId', 'ticketId', 'rulesDigest', 'claimDigest', 'directoryIdentity', 'storeIdentity', 'initialDigest', 'digest'], 'Ticket binding');
    expect(record.schemaVersion === 1 && record.registryId === anchor.registryId && record.repoId === anchor.repoId
      && record.ticketId === ticketId && record.rulesDigest === anchor.rulesDigest && record.claimDigest === claim.digest
      && same(record.directoryIdentity, identity(path.directory, true)) && same(record.storeIdentity, identity(path.store))
      && record.initialDigest === createRetryJournal({ ticketId, rules }).digest,
    'Ticket store was replaced or rebound', 'REGISTRY_BINDING_MISMATCH');
    return { path, record };
  }
  function checkpointRecord(ticketId, record, journal) {
    return envelope({ schemaVersion: 1, registryId: anchor.registryId, ticketId, bindingDigest: record.digest,
      eventCount: journal.events.length, journalDigest: journal.digest });
  }
  function checkpointPath(path, count) { return join(path.checkpoints, `${String(count).padStart(3, '0')}.json`); }
  function verifyCheckpoints(ticketId, record, path, journal) {
    const names = readdirSync(path.checkpoints).sort();
    expect(names.length > 0 && names.length <= 257 && names.every(name => /^\d{3}\.json$/.test(name)),
      'Invalid/missing registry checkpoints', 'REGISTRY_CHECKPOINT_MISMATCH');
    expect(names.includes('000.json'), 'Initial checkpoint missing', 'REGISTRY_CHECKPOINT_MISMATCH');
    const prefixes = new Map([[0, record.initialDigest]]);
    for (let count = 1; count <= journal.events.length; count++) prefixes.set(count,
      digest({ schemaVersion: 1, ticketId, rulesDigest: anchor.rulesDigest, events: journal.events.slice(0, count) }));
    let latest = 0;
    for (const name of names) {
      const count = Number(name.slice(0, 3)), checkpoint = read(join(path.checkpoints, name));
      const expected = checkpointRecord(ticketId, record, { events: Array(count), digest: prefixes.get(count) ?? 'missing' });
      expect(prefixes.has(count) && same(checkpoint, expected), 'Journal rolled back or diverged from a retained checkpoint', 'REGISTRY_CHECKPOINT_MISMATCH');
      latest = Math.max(latest, count);
    }
    return { eventCount: latest, journalDigest: prefixes.get(latest), lagging: latest !== journal.events.length };
  }
  async function openTicket(ticketId, { readOnly = false } = {}) {
    const frozen = binding(ticketId), store = await openRetryStore({ filename: frozen.path.store, ticketId, rules, readOnly });
    function load() {
      const current = binding(ticketId);
      expect(same(current.record, frozen.record), 'Ticket binding changed while open', 'REGISTRY_BINDING_MISMATCH');
      const snapshot = store.read(), checkpoint = verifyCheckpoints(ticketId, frozen.record, frozen.path, snapshot.journal);
      return { ...snapshot, checkpoint, registry: { registryId: anchor.registryId, repoId: anchor.repoId, ticketId,
        bindingDigest: frozen.record.digest, anchored: true, wholeRegistryRollbackProtected: false },
      state: { ...snapshot.state, unresolved: [...snapshot.state.unresolved.filter(item => !['stable-ticket-store-binding', 'rollback-protection'].includes(item)),
        'whole-registry-rollback-protection'] } };
    }
    try { load(); } catch (error) { store.close(); throw error; }
    function seal(expectedDigest) {
      expect(!readOnly, 'Read-only registry handle cannot checkpoint', 'RETRY_STORE_READ_ONLY');
      const snapshot = load();
      expect(snapshot.journal.digest === expectedDigest, 'Journal moved before checkpoint', 'STALE_RETRY_JOURNAL');
      publish(checkpointPath(frozen.path, snapshot.journal.events.length), checkpointRecord(ticketId, frozen.record, snapshot.journal), frozen.path.directory);
      const sealed = load();
      expect(!sealed.checkpoint.lagging, 'Journal advanced during checkpoint; re-read before proceeding', 'REGISTRY_CHECKPOINT_PENDING');
      return sealed;
    }
    return {
      read: load,
      checkpoint({ expectedDigest }) { return seal(expectedDigest); },
      append({ expectedDigest, event }) {
        const next = copy(event), before = load();
        expect(!before.checkpoint.lagging || before.journal.events.some(previous => same(previous, next)),
          'Unacknowledged history requires checkpoint or identical event replay before new work', 'REGISTRY_CHECKPOINT_PENDING');
        const result = store.append({ expectedDigest, event: next });
        return { ...seal(result.journal.digest), applied: result.applied };
      },
      close() { store.close(); },
    };
  }
  return {
    async register(ticketId) {
      check(); const path = paths(ticketId);
      const claim = envelope({ schemaVersion: 1, registryId: anchor.registryId, repoId: anchor.repoId, ticketId, allocationId: randomUUID() });
      try { publish(path.claim, claim); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await openTicket(ticketId, { readOnly: true });
        try { return { created: false, ...existing.read() }; } finally { existing.close(); }
      }
      mkdirSync(path.directory, { mode: 0o700 });
      mkdirSync(path.checkpoints, { mode: 0o700 });
      await createRetryStore({ filename: path.store, ticketId, rules }); check();
      const journal = createRetryJournal({ ticketId, rules });
      const record = envelope({ schemaVersion: 1, registryId: anchor.registryId, repoId: anchor.repoId, ticketId,
        rulesDigest: anchor.rulesDigest, claimDigest: claim.digest, directoryIdentity: identity(path.directory, true), storeIdentity: identity(path.store), initialDigest: journal.digest });
      publish(checkpointPath(path, 0), checkpointRecord(ticketId, record, journal), path.directory);
      publish(path.binding, record);
      const registered = await openTicket(ticketId, { readOnly: true });
      try { return { created: true, ...registered.read() }; } finally { registered.close(); }
    },
    openTicket,
  };
}
