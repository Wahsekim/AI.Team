import { lstatSync, realpathSync, mkdtempSync, rmSync, chmodSync, linkSync, openSync, readSync, fstatSync, closeSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { canonical, digest, parseJSON, requireThat } from '../loop/contracts.mjs';
import { createRetryJournal, advanceRetryJournal, inspectRetryJournal } from './retries.mjs';

const TABLES = [
  `CREATE TABLE rw_metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, ticket_id TEXT NOT NULL, rules_digest TEXT NOT NULL, head_digest TEXT NOT NULL, event_count INTEGER NOT NULL)`,
  `CREATE TABLE rw_events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_digest TEXT NOT NULL, previous_digest TEXT NOT NULL, journal_digest TEXT NOT NULL, body TEXT NOT NULL)`,
];
const SCHEMA = [
  { type: 'index', name: 'sqlite_autoindex_rw_events_1', tbl_name: 'rw_events', sql: null },
  { type: 'table', name: 'rw_events', tbl_name: 'rw_events', sql: TABLES[1] },
  { type: 'table', name: 'rw_metadata', tbl_name: 'rw_metadata', sql: TABLES[0] },
];
const expect = (condition, message, code = 'INVALID_RETRY_STORE') => requireThat(condition, code, message);
const copy = value => parseJSON(canonical(value));

async function sqlite() {
  expect(Number(process.versions.node.split('.')[0]) >= 24, 'Retry persistence requires Node 24+', 'CAPABILITY_MISSING');
  return (await import('node:sqlite')).DatabaseSync;
}
function location(filename) {
  expect(typeof filename === 'string' && isAbsolute(filename) && resolve(filename) === filename,
    'Use a normalized absolute retry-store filename');
  expect(basename(filename).endsWith('.rw-retries.sqlite')
    && !filename.split(sep).some(part => ['.git', '.claude'].includes(part)), 'Retry stores must be dedicated .rw-retries.sqlite files outside runtime/Git metadata');
  expect(realpathSync(dirname(filename)) === dirname(filename), 'Canonical existing store parent required');
  return filename;
}
function identity(filename) {
  location(filename);
  const stat = lstatSync(filename, { bigint: true });
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= 16n * 1024n * 1024n,
    'Store must be a bounded regular file without symlink or hard-link aliases');
  expect((stat.mode & 0o077n) === 0n, 'Store permissions must not grant group/other access');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function sidecars(filename) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      const stat = lstatSync(filename + suffix, { bigint: true });
      expect(suffix === '-journal' && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
        && stat.size <= 16n * 1024n * 1024n, 'Unsupported or unsafe SQLite sidecar');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function header(filename, pinned) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true }), bytes = Buffer.alloc(100);
    expect(String(stat.dev) === pinned.dev && String(stat.ino) === pinned.ino, 'Store changed while opening', 'RETRY_STORE_REPLACED');
    expect(readSync(fd, bytes, 0, bytes.length, 0) === bytes.length
      && bytes.subarray(0, 16).toString('ascii') === 'SQLite format 3\0'
      && bytes[18] === 1 && bytes[19] === 1, 'Expected a rollback-journal SQLite database, not an unknown or WAL file');
  } finally { closeSync(fd); }
}
function schema(db) {
  const rows = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  expect(JSON.stringify(rows) === JSON.stringify(SCHEMA), 'Unknown or modified retry-store schema');
  expect(db.prepare('PRAGMA journal_mode').get().journal_mode === 'delete', 'Only rollback-journal stores are supported');
}
function configure(db) { db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;'); }

export async function createRetryStore({ filename, ticketId, rules }) {
  const policy = copy(rules), DatabaseSync = await sqlite(), path = location(filename);
  const journal = createRetryJournal({ ticketId, rules: policy });
  const temp = mkdtempSync(join(dirname(path), '.rw-retries-')), scratch = join(temp, 'store.sqlite');
  let db;
  try {
    db = new DatabaseSync(scratch); configure(db);
    db.exec('BEGIN IMMEDIATE');
    for (const sql of TABLES) db.exec(sql);
    db.prepare('INSERT INTO rw_metadata VALUES (1,1,?,?,?,0)').run(ticketId, digest(policy), journal.digest);
    db.exec('COMMIT'); db.close(); db = null;
    chmodSync(scratch, 0o600);
    // Exclusive publication never overwrites an existing file, even a dangling symlink.
    linkSync(scratch, path);
  } finally { if (db) db.close(); rmSync(temp, { recursive: true, force: true }); }
  return { filename: path, journalDigest: journal.digest, launchable: false };
}

export async function openRetryStore({ filename, ticketId, rules, readOnly = false }) {
  const policy = copy(rules), DatabaseSync = await sqlite(), path = location(filename);
  expect(typeof readOnly === 'boolean', 'readOnly must be explicit boolean');
  const initial = createRetryJournal({ ticketId, rules: policy }), pinned = identity(path);
  sidecars(path); header(path, pinned);
  const db = new DatabaseSync(path, { readOnly });
  let closed = false;
  const checkFile = () => {
    expect(!closed, 'Retry store is closed', 'RETRY_STORE_CLOSED');
    expect(canonical(identity(path)) === canonical(pinned), 'Retry-store path was replaced', 'RETRY_STORE_REPLACED');
    sidecars(path);
  };
  function load() {
    schema(db);
    const rows = db.prepare('SELECT * FROM rw_metadata').all();
    expect(rows.length === 1 && rows[0].id === 1 && rows[0].version === 1 && rows[0].ticket_id === ticketId
      && rows[0].rules_digest === initial.rulesDigest, 'Ticket, schema or source-rule binding mismatch');
    const meta = rows[0];
    expect(Number.isInteger(meta.event_count) && meta.event_count >= 0 && meta.event_count <= 256, 'Invalid stored event count');
    const events = db.prepare('SELECT * FROM rw_events ORDER BY seq LIMIT 257').all();
    expect(events.length === meta.event_count, 'Stored event count does not match history');
    let journal = initial;
    for (let i = 0; i < events.length; i++) {
      const row = events[i], event = parseJSON(row.body);
      expect(row.seq === i + 1 && row.event_id === event.eventId && row.body === canonical(event)
        && row.event_digest === digest(event) && row.previous_digest === journal.digest, 'Retry event chain is inconsistent');
      const body = { schemaVersion: 1, ticketId, rulesDigest: initial.rulesDigest, events: [...journal.events, event] };
      journal = { ...body, digest: digest(body) };
      expect(row.journal_digest === journal.digest, 'Retry prefix digest mismatch');
    }
    expect(meta.head_digest === journal.digest, 'Retry head digest mismatch');
    const state = inspectRetryJournal({ journal, rules: policy });
    return { journal, state: { ...state, unresolved: [...state.unresolved.filter(item => item !== 'durable-journal'),
      'stable-ticket-store-binding', 'rollback-protection'] },
      storage: { version: 1, eventCount: events.length, persisted: true, exclusiveTargetOwner: false, readOnly } };
  }
  function transaction(write, operation) {
    checkFile(); expect(!write || !readOnly, 'Read-only store cannot append', 'RETRY_STORE_READ_ONLY');
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = operation(); checkFile(); db.exec('COMMIT'); return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back a failed commit. */ } throw error; }
  }
  try { checkFile(); configure(db); transaction(false, load); }
  catch (error) { db.close(); closed = true; throw error; }
  return {
    read() { return transaction(false, load); },
    append({ expectedDigest, event }) {
      const next = copy(event);
      return transaction(true, () => {
        const current = load(), existing = current.journal.events.find(value => value.eventId === next.eventId);
        if (existing) {
          expect(canonical(existing) === canonical(next), 'Event ID reused with different content', 'IDEMPOTENCY_CONFLICT');
          const original = db.prepare('SELECT previous_digest FROM rw_events WHERE event_id=?').get(next.eventId);
          expect(expectedDigest === current.journal.digest || expectedDigest === original.previous_digest,
            'Replay request does not identify its original or current journal version', 'STALE_RETRY_JOURNAL');
          return { ...current, applied: false };
        }
        const result = advanceRetryJournal({ journal: current.journal, rules: policy, expectedDigest, event: next });
        const seq = result.journal.events.length;
        db.prepare('INSERT INTO rw_events VALUES (?,?,?,?,?,?)').run(seq, next.eventId, digest(next), current.journal.digest,
          result.journal.digest, canonical(next));
        db.prepare('UPDATE rw_metadata SET head_digest=?,event_count=? WHERE id=1').run(result.journal.digest, seq);
        return { ...load(), applied: true };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
