import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { instanceOf } from './roots.mjs';
import { DEFAULT_LIMITS } from './switch.mjs';

// ADR 0010, decision 7: the kit proposes the staffing and the limits of a Router/Worker team. The request is
// drafted from what the bootstrap interview recorded in profiles/project.md; the owner confirms it at the switch.
const WORKFLOWS = Array.from({ length: 32 }, (_, i) => `WF-${String(i).padStart(2, '0')}`);
const READ = ['Read', 'Grep', 'Glob'];
const refused = reason => ({ errors: [{ code: 'REQUEST_REFUSED', field: 'request', reason }] });

export function draftRequest({ teamRoot, instanceRoot, model = 'opus', ui = false }) {
  let instance, text;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { return refused(`Router/Worker mode needs the two-root layout (${error.message})`); }
  if (!instance) return refused('An instance root is required');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(model)) return refused('The model must be a roster model identifier');
  try { text = readFileSync(join(instance, 'profiles/project.md'), 'utf8'); } catch { return refused('profiles/project.md is missing; finish the bootstrap first'); }
  const field = name => new RegExp(`^\\s*${name}:\\s*"([^"\\n]*)"`, 'm').exec(text)?.[1]?.trim();
  const answers = { name: field('name'), slug: field('slug'), product_repo_path: field('product_repo_path') };
  const open = Object.entries(answers).filter(([, value]) => !value || value.includes('{{')).map(([name]) => name);
  if (open.length) return refused(`profiles/project.md does not answer: ${open.join(', ')}; finish the bootstrap interview first`);
  let productRoot = resolve(instance, answers.product_repo_path);
  try { productRoot = realpathSync(productRoot); } catch { return refused(`The product repository ${productRoot} does not exist`); }

  const workflowStates = {}, notes = [], unreadable = [];
  for (const id of WORKFLOWS) {
    const line = new RegExp(`^\\s*${id}:\\s*"([^"\\n]*)"`, 'm').exec(text)?.[1] ?? '';
    const [, status, reason] = /^(enabled|deferred|profile-bound|disabled)\b[\s—–:,(-]*(.*?)\)?\s*$/.exec(line.trim()) ?? [];
    if (!status) { unreadable.push(id); continue; }
    workflowStates[id] = { status, reason: reason || 'As recorded in profiles/project.md', decisionRef: null };
    if (status === 'disabled') notes.push(`${id} is disabled: put the digest of the owner's decision in its decisionRef before the switch`);
  }
  if (unreadable.length) return refused(`profiles/project.md gives no status (enabled, deferred, profile-bound or disabled) for: ${unreadable.join(', ')}`);

  const worker = (effort, maxTurns, tools) => ({ model, effort, maxTurns, tools }), writes = worker('medium', 40, [...READ, 'Write', 'Edit']), reads = worker('medium', 40, READ);
  const spec = { schemaVersion: 1, mode: 'router-worker', project: { name: answers.name, slug: answers.slug, productRoot, ui: ui === true },
    profiles: { exec: worker('high', 120, [...READ, 'Bash', 'Write', 'Edit']), check: worker('medium', 80, [...READ, 'Bash']), guard: worker('high', 40, READ) },
    governance: { architect: writes, coach: writes, auditor: reads, security: reads }, workflowStates };
  return { request: { spec, limits: { ...DEFAULT_LIMITS } }, notes };
}
