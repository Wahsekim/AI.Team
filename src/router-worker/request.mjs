import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { instanceOf } from './roots.mjs';
import { DEFAULT_LIMITS, MAX_COMMANDS, oneCommand } from './switch.mjs';
import { readStackSource } from './stack-source.mjs';

// ADR 0010, decision 7: the kit proposes the staffing and the limits of a Router/Worker team. The request is
// drafted from what the bootstrap interview recorded in profiles/project.md; the owner confirms it at the switch.
const WORKFLOWS = Array.from({ length: 32 }, (_, i) => `WF-${String(i).padStart(2, '0')}`);
const READ = ['Read', 'Grep', 'Glob'], FIELDS = ['name', 'slug', 'product_repo_path'];
const refused = reason => ({ errors: [{ code: 'REQUEST_REFUSED', field: 'request', reason }] });

export function draftRequest({ teamRoot, instanceRoot, model = 'opus', ui = false }) {
  let instance, text;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { return refused(`Router/Worker mode needs the two-root layout (${error.message})`); }
  if (!instance) return refused('An instance root is required');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(model)) return refused('The model must be a roster model identifier');
  try { text = readFileSync(join(instance, 'profiles/project.md'), 'utf8'); } catch { return refused('profiles/project.md is missing; finish the bootstrap first'); }
  // Only the profile's own YAML blocks are read: a line elsewhere in the file is prose.
  const block = key => {
    const found = [...text.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map(match => match[1]).filter(body => body.startsWith(`${key}:\n`));
    if (found.length !== 1) return null;
    const values = new Map(), twice = new Set();
    for (const line of found[0].split('\n').slice(1)) {
      const [, name, value] = /^\s+([A-Za-z0-9_-]+):\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line) ?? [];
      if (name) { if (values.has(name)) twice.add(name); values.set(name, value.trim()); }
    }
    return { values, twice: [...twice] };
  };
  const project = block('project'), statuses = block('workflow_status');
  if (!project || !statuses) return refused('profiles/project.md must hold exactly one ```yaml block starting with "project:" and one starting with "workflow_status:"');
  const twice = [...project.twice.filter(name => FIELDS.includes(name)), ...statuses.twice];
  if (twice.length) return refused(`profiles/project.md gives more than one value for: ${twice.join(', ')}`);
  const answers = Object.fromEntries(FIELDS.map(name => [name, project.values.get(name)]));
  const open = FIELDS.filter(name => !answers[name] || answers[name].includes('{{'));
  if (open.length) return refused(`profiles/project.md does not answer: ${open.join(', ')} (each a double-quoted value on one line); finish the bootstrap interview first`);
  let productRoot = resolve(instance, answers.product_repo_path);
  try { productRoot = realpathSync(productRoot); } catch { return refused(`The product repository ${productRoot} does not exist`); }

  const workflowStates = {}, notes = [], unreadable = [];
  for (const id of WORKFLOWS) {
    // The status, alone or followed by " — reason", " - reason", ": reason" or " (reason)".
    const [, status, dashed, coloned, bracketed] = /^(enabled|deferred|profile-bound|disabled)(?:\s+[—–-]\s+(.+)|:\s+(.+)|\s+\((.+)\))?$/.exec(statuses.values.get(id) ?? '') ?? [];
    if (!status) { unreadable.push(id); continue; }
    workflowStates[id] = { status, reason: dashed ?? coloned ?? bracketed ?? 'As recorded in profiles/project.md', decisionRef: null };
    if (status === 'disabled') notes.push(`${id} is disabled: put the digest of the owner's decision in its decisionRef before the switch`);
  }
  if (unreadable.length) return refused(`profiles/project.md must give each workflow a double-quoted status (enabled, deferred, profile-bound or disabled, then optionally " — reason"); not readable: ${unreadable.join(', ')}`);
  if (ui !== true && lstatSync(join(instance, 'agents/_shared/browser-access.md'), { throwIfNoEntry: false })) notes.push('agents/_shared/browser-access.md exists but the request is drafted for a project without a UI; pass --ui if it has one');

  const worker = (effort, maxTurns, tools) => ({ model, effort, maxTurns, tools }), writes = worker('medium', 40, [...READ, 'Write', 'Edit']), reads = worker('medium', 40, READ);
  const spec = { schemaVersion: 1, mode: 'router-worker', project: { name: answers.name, slug: answers.slug, productRoot, ui: ui === true },
    profiles: { exec: worker('high', 120, [...READ, 'Bash', 'Write', 'Edit']), check: worker('medium', 80, [...READ, 'Bash']), guard: worker('high', 40, READ) },
    governance: { architect: writes, coach: writes, auditor: reads, security: reads }, workflowStates };
  // The commands a worker runs without a permission prompt are proposed from the project's own stack profile.
  const stack = readStackSource({ root: instance });
  if (stack.errors) notes.push(`profiles/stack.md gives no verification commands (${stack.errors[0].reason}); allowedCommands is empty, and no batch can start until it lists them`);
  const gates = stack.errors ? [] : stack.verificationCommands, unfit = gates.filter(gate => !oneCommand(gate));
  if (unfit.length) notes.push(`profiles/stack.md lists ${unfit.length} gate(s) that cannot be confirmed as they are written (one line of printable ASCII with single spaces, at most 300 characters); they are left out of allowedCommands: ${unfit.map(gate => JSON.stringify(gate.slice(0, 80))).join(', ')}`);
  const fit = gates.filter(oneCommand), beyond = fit.slice(MAX_COMMANDS);
  if (beyond.length) notes.push(`profiles/stack.md lists ${beyond.length} gate(s) beyond the ${MAX_COMMANDS} a team may confirm; they are left out of allowedCommands: ${beyond.map(gate => JSON.stringify(gate)).join(', ')}`);
  return { request: { spec, limits: { ...DEFAULT_LIMITS, allowedCommands: fit.slice(0, MAX_COMMANDS) } }, notes };
}
