// Rollout gate G-01: verification commands are read from the project's own
// profiles/stack.md. The kit holds no stack-specific command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readStackSource, checkStackBinding } from '../src/router-worker/stack-source.mjs';
import { compile } from '../src/router-worker/compile.mjs';
import { digest, bytesDigest } from '../src/loop/contracts.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const CLI = fileURLToPath(new URL('../scripts/stack-source-router-worker.mjs', import.meta.url));
const stack = (required = ['"make lint"', '"make test   # unit and widget"'], extra = '') => `# Stack Profile

\`\`\`yaml
stack:
  status: "locked"
  test_command: "not the gate list"
\`\`\`

## Verification Gates

\`\`\`yaml
verification:
  code_shipping:
    required:
${required.map(line => `      - ${line}`).join('\n')}
    conditional:
      ui_change: "screenshots, light + dark"
      schema_change: "migration test passes"
  docs_only:
    required:
      - "link/check referenced files"
\`\`\`
${extra}`;
function fixture(t, text = stack()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-stack-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'profiles'));
  if (text !== null) writeFileSync(join(root, 'profiles/stack.md'), text);
  return root;
}
const code = result => result.errors?.[0].code;

test('the required code-shipping gates of the project stack profile become the verification commands', t => {
  const root = fixture(t), record = readStackSource({ root });
  assert.equal(record.errors, undefined, JSON.stringify(record.errors));
  assert.deepEqual(record.verificationCommands, ['make lint', 'make test   # unit and widget'], 'verbatim, in order; only code_shipping.required');
  assert.deepEqual(record.conditional, { ui_change: 'screenshots, light + dark', schema_change: 'migration test passes' });
  assert.equal(record.source, 'profiles/stack.md'); assert.equal(record.sha256, bytesDigest(stack()));
  assert.deepEqual(record.stackRef, { id: 'profiles-stack-code-shipping', digest: digest(record.verificationCommands) });
  assert.ok(record.unresolved.includes('conditional-gate-selection'));
  const { digest: recorded, ...body } = record;
  assert.equal(recorded, digest(body)); assert.deepEqual(readStackSource({ root }), record);
});

test('a compiler input is bound to the profile: same commands, same reference, and it still compiles', t => {
  const root = fixture(t), record = readStackSource({ root }), input = inputFixture();
  assert.equal(code(checkStackBinding(input, record)), 'STACK_SOURCE_MISMATCH', 'hand-typed commands are not the profile');
  input.policy.verificationCommands = record.verificationCommands; input.policy.stackRef = record.stackRef;
  input.mandate.policyDigest = digest(input.policy);
  assert.deepEqual(checkStackBinding(input, record), { bound: true, stackRef: record.stackRef, sourceSha256: record.sha256 });
  assert.equal(compile(input).errors, undefined);
  const reordered = structuredClone(input); reordered.policy.verificationCommands.reverse();
  assert.equal(code(checkStackBinding(reordered, record)), 'STACK_SOURCE_MISMATCH');
  const dropped = structuredClone(input); dropped.policy.verificationCommands.pop();
  assert.equal(code(checkStackBinding(dropped, record)), 'STACK_SOURCE_MISMATCH', 'a gate cannot be left out');
  const stale = structuredClone(input); stale.policy.stackRef = { id: record.stackRef.id, digest: digest('older profile') };
  assert.equal(code(checkStackBinding(stale, record)), 'STACK_SOURCE_MISMATCH');
});

test('an unresolved, missing or unreadable profile yields no commands', t => {
  assert.equal(code(readStackSource({ root: fixture(t, null) })), 'STACK_SOURCE_MISSING');
  assert.equal(code(readStackSource({ root: fixture(t, stack(['"{{BUILD_COMMAND | or per-package commands}}"', '"make test"'])) })), 'STACK_UNRESOLVED', 'a seed placeholder is not a command');
  assert.equal(code(readStackSource({ root: fixture(t, '# Stack Profile\n\nNo gates here.\n') })), 'STACK_SOURCE_UNREADABLE');
  assert.equal(code(readStackSource({ root: fixture(t, stack([])) })), 'STACK_SOURCE_UNREADABLE', 'an empty gate list is not a gate list');
  assert.equal(code(readStackSource({ root: fixture(t, stack(['"make test"', '"make test"'])) })), 'STACK_SOURCE_UNREADABLE', 'duplicate gates');
  assert.equal(code(readStackSource({ root: fixture(t, stack() + stack()) })), 'STACK_SOURCE_UNREADABLE', 'two verification blocks are ambiguous');
  const real = fixture(t), link = `${real}-link`; symlinkSync(real, link); t.after(() => rmSync(link, { force: true }));
  assert.equal(code(readStackSource({ root: link })), 'STACK_SOURCE_MISSING', 'a non-canonical root is refused');
});

test('CLI prints the record, checks an input when given, exits 2 on refusal and 1 on usage', t => {
  const root = fixture(t), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  const ok = run('--root', root);
  assert.equal(ok.status, 0, ok.stderr); assert.deepEqual(JSON.parse(ok.stdout).verificationCommands, ['make lint', 'make test   # unit and widget']);
  const file = join(root, 'input.json'); writeFileSync(file, JSON.stringify(inputFixture()));
  assert.equal(run('--root', root, file).status, 2);
  assert.equal(run().status, 1);
});
