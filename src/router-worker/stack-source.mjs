import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { canonical, digest, bytesDigest } from '../loop/contracts.mjs';

// Rollout gate G-01: the verification commands of a compiler input come from the
// project's own profiles/stack.md (verification.code_shipping.required). The kit
// carries no stack-specific command.
const SOURCE = 'profiles/stack.md';
const UNRESOLVED = ['conditional-gate-selection', 'partially-applicable-gate-review', 'command-executability', 'owner-review-of-the-profile'];

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, code, reason) => { if (!condition) throw new Refusal(code, reason); };
const fail = error => ({ errors: [{ code: error instanceof Refusal ? error.code : 'STACK_SOURCE_UNREADABLE', field: 'stack', reason: error.message }] });
const indent = line => line.length - line.trimStart().length;
const unquote = text => { const t = text.trim(); return /^".*"$/.test(t) ? t.slice(1, -1) : t; };

// The lines nested under `key:` at the given indent, up to the next line that is not deeper.
function nested(lines, key, depth) {
  const at = lines.findIndex(line => line.trimEnd() === `${' '.repeat(depth)}${key}:`);
  if (at < 0) return null;
  const end = lines.findIndex((line, i) => i > at && line.trim() && indent(line) <= depth);
  return lines.slice(at + 1, end < 0 ? lines.length : end).filter(line => line.trim());
}

function parse(text) {
  const blocks = [...text.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map(match => match[1].split('\n')).filter(lines => lines.includes('verification:'));
  need(blocks.length === 1, 'STACK_SOURCE_UNREADABLE', 'profiles/stack.md must hold exactly one yaml block with a verification section');
  const codeShipping = nested(blocks[0], 'code_shipping', 2), required = codeShipping && nested(codeShipping, 'required', 4);
  need(required?.length && required.every(line => /^ {6}- \S/.test(line)), 'STACK_SOURCE_UNREADABLE', 'verification.code_shipping.required is missing, empty or not a plain list');
  const commands = required.map(line => unquote(line.slice(8)));
  need(new Set(commands).size === commands.length && commands.every(command => command && command.length <= 1000 && !/[\x00-\x1f\x7f]/.test(command)),
    'STACK_SOURCE_UNREADABLE', 'Required gates must be distinct single-line commands');
  need(!commands.some(command => command.includes('{{')), 'STACK_UNRESOLVED', 'A required gate is still a seed placeholder; resolve the stack profile first');
  const conditional = Object.fromEntries((nested(codeShipping, 'conditional', 4) ?? []).map(line => /^ {6}([A-Za-z0-9_]+):\s*(.+)$/.exec(line))
    .filter(Boolean).map(match => [match[1], unquote(match[2])]));
  return { commands, conditional };
}

export function readStackSource({ root }) {
  try {
    need(typeof root === 'string' && isAbsolute(root) && resolve(root) === root && lstatSync(root, { throwIfNoEntry: false })?.isDirectory()
      && realpathSync(root) === root && lstatSync(join(root, SOURCE), { throwIfNoEntry: false })?.isFile(), 'STACK_SOURCE_MISSING',
    'A canonical root holding profiles/stack.md is required');
    const bytes = readFileSync(join(root, SOURCE)), { commands, conditional } = parse(bytes.toString('utf8'));
    const body = { schemaVersion: 1, source: SOURCE, sha256: bytesDigest(bytes), verificationCommands: commands, conditional,
      stackRef: { id: 'profiles-stack-code-shipping', digest: digest(commands) }, unresolved: UNRESOLVED };
    return { ...body, digest: digest(body) };
  } catch (error) { return fail(error); }
}

export function checkStackBinding(input, record) {
  try {
    need(canonical(input?.policy?.verificationCommands) === canonical(record.verificationCommands)
      && canonical(input.policy.stackRef) === canonical(record.stackRef), 'STACK_SOURCE_MISMATCH',
    'policy.verificationCommands and policy.stackRef must be exactly the required gates of the project stack profile');
    return { bound: true, stackRef: record.stackRef, sourceSha256: record.sha256 };
  } catch (error) { return fail(error instanceof Refusal ? error : new Refusal('STACK_SOURCE_MISMATCH', 'The input carries no readable policy')); }
}
