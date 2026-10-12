import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Test-only (R05b V8): leaves a hot rollback journal deterministically. A tiny page cache spills inside one open
// transaction, so SQLite syncs the journal and overwrites database pages before COMMIT (R05a review F1).
// The parent SIGKILLs this process after "spilled"; it self-exits within 10 s otherwise.
const [file, extraSql = ''] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA cache_size=2; BEGIN IMMEDIATE');
if (extraSql) db.exec(extraSql);
db.exec('CREATE TABLE r05b_spill(x BLOB)');
const insert = db.prepare('INSERT INTO r05b_spill VALUES (randomblob(1000))');
for (let i = 0; i < 3000; i++) insert.run();
writeSync(1, `${JSON.stringify({ spilled: true })}\n`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
process.exit(9);
