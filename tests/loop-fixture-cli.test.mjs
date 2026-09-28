import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEvidenceArchive } from '../src/loop/evidence.mjs';
const cli = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Requires Node 24+' : false };
test('fixture CLI executes isolated processes/gates and exposes readable durable results', sqlite, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'ai-cli-fixture-')), directory = join(parent, 'new-run');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const call = action => execFileSync(process.execPath, [cli, action, directory, 'fixture-run'], { encoding: 'utf8', timeout: 15000 });
  const result = JSON.parse(call('fixture'));
  assert.equal(result.simulation, true); assert.equal(result.value.state.status, 'COMPLETED');
  assert.match(call('show'), /FIXTURE-1.*Verify the isolated execution pipeline/);
  assert.equal(JSON.parse(call('audit')).value.ok, true);
  assert.match(readFileSync(join(directory, 'fixture-run.projection-1.md'), 'utf8'), /not evidence of a real product build/);
  const archive = await openEvidenceArchive(join(directory, 'evidence.sqlite'));
  try { for (const dispatchId of ['d-2', 'd-3']) assert.equal(archive.get('fixture-run', dispatchId).record.evidence.result, 'pass'); }
  finally { archive.close(); }
  const before = readFileSync(join(directory, 'loop.sqlite'));
  const repeated = spawnSync(process.execPath, [cli, 'fixture', directory, 'other-run'], { encoding: 'utf8' });
  assert.equal(repeated.status, 2); assert.equal(JSON.parse(repeated.stdout).code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(readFileSync(join(directory, 'loop.sqlite')), before);
});
test('fixture CLI preserves an existing non-state directory without running its contents', sqlite, t => {
  const parent = mkdtempSync(join(tmpdir(), 'ai-cli-existing-')), directory = join(parent, 'existing');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(directory); writeFileSync(join(directory, 'owner.txt'), 'preserve');
  const result = spawnSync(process.execPath, [cli, 'fixture', directory, 'run'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(readFileSync(join(directory, 'owner.txt'), 'utf8'), 'preserve');
});
test('fixture command handles its SIGINT through durable stop and bounded closeout', sqlite, t => {
  const parent = mkdtempSync(join(tmpdir(), 'ai-cli-signal-')), directory = join(parent, 'interrupted');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/loop/fixture-demo.mjs', import.meta.url).href;
  // Send an actual signal only after this test child installs its handler.
  const source = `const original = process.on;
    process.on = function(name, handler) { const result = original.call(this, name, handler);
      if (name === 'SIGINT') setImmediate(() => process.kill(process.pid, 'SIGINT')); return result; };
    const { runFixtureDemo } = await import(${JSON.stringify(moduleUrl)});
    const result = await runFixtureDemo({ directory: ${JSON.stringify(directory)}, runId: 'signal-run' });
    process.stdout.write(JSON.stringify(result));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 }));
  assert.equal(result.state.status, 'STOPPED'); assert.equal(result.state.reason, 'user_stop');
  assert.equal(result.state.stopRequest.mode, 'hard'); assert.equal(result.state.projection.status, 'ACKNOWLEDGED');
});
