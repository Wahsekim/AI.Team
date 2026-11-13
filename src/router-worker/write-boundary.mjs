import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { canonical, digest, parseJSON } from '../loop/contracts.mjs';
import { compile } from './compile.mjs';

// Runtime write boundary of one Router/Worker run. Arming freezes, per wrapper,
// the product paths its file tools may write; the PreToolUse hook judges each
// call against that file. Bash writes are outside this boundary.
export const BOUNDARY_FILE = '.claude/rw-write-boundary.json';
const SETTINGS = '.claude/settings.json';
const MATCHER = 'Write|Edit|NotebookEdit|MultiEdit';
const WRITE_TOOLS = MATCHER.split('|');
const DUTIES = ['exec', 'check', 'guard'];
const UNRESOLVED = ['hook-fires-inside-workflow-agents', 'bash-writes', 'deny-under-non-default-permission-modes'];

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, reason) => { if (!condition) throw new Refusal('BOUNDARY_REFUSED', reason); };
const canonicalDirectory = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && realpathSync(path) === path;
const within = (path, grants) => grants.some(grant => grant.endsWith('/**') ? path.startsWith(grant.slice(0, -2)) : path === grant);

export function armBoundary({ inputs, teamRoot, productRoot, hookPath, methodBundle }) {
  try {
    need(canonicalDirectory(teamRoot) && canonicalDirectory(productRoot), 'Canonical existing team and product roots are required');
    let mode;
    try { mode = JSON.parse(readFileSync(join(teamRoot, 'profiles/team-mode.json'), 'utf8')); } catch { mode = null; }
    // Only a disposable activated copy is written; a standing instance keeps its settings.
    need(mode?.status === 'activated-disposable-smoke', 'The team root is not an activated disposable copy');
    need(Array.isArray(inputs) && inputs.length >= 1 && inputs.length <= 300 && typeof hookPath === 'string' && isAbsolute(hookPath), 'inputs and an absolute hook path are required');
    const frozen = inputs.map(input => parseJSON(canonical(input))), failed = frozen.map(input => compile(input, methodBundle ? { methodBundle } : {})).find(preview => preview.errors);
    if (failed) return { errors: failed.errors };
    const policy = frozen[0].policy;
    need(frozen.every(input => digest(input.policy) === digest(policy)), 'Every ticket of one run must carry the same policy');
    const writePaths = [...new Set(frozen.flatMap(input => input.mandate.allowedWritePaths))].sort();
    const body = { schemaVersion: 1, productRoot, wrappers: Object.fromEntries(DUTIES.map(duty =>
      [policy.profiles[duty].wrapper, { duty, writePaths: duty === 'exec' ? writePaths : [] }])) };
    need(Object.keys(body.wrappers).length === DUTIES.length, 'Two duties share one wrapper');
    const boundary = { ...body, digest: digest(body) };

    const settingsPath = join(teamRoot, SETTINGS);
    let settings = {};
    if (lstatSync(settingsPath, { throwIfNoEntry: false })) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = null; }
      need(settings && typeof settings === 'object' && !Array.isArray(settings), `${SETTINGS} is not a JSON object`);
    }
    const command = `node "${hookPath}"`, existing = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
    const registered = existing.some(entry => entry?.matcher === MATCHER && entry.hooks?.some(hook => hook?.command === command));
    const next = { ...settings, hooks: { ...settings.hooks, PreToolUse: registered ? existing : [...existing, { matcher: MATCHER, hooks: [{ type: 'command', command }] }] } };
    writeFileSync(join(teamRoot, BOUNDARY_FILE), JSON.stringify(boundary, null, 2) + '\n');
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
    const record = { schemaVersion: 1, stage: 'write-boundary-armed', launchable: false, boundaryDigest: boundary.digest,
      wrappers: Object.keys(boundary.wrappers), writePathCount: writePaths.length, unresolved: UNRESOLVED };
    return { ...record, digest: digest(record) };
  } catch (error) {
    if (error instanceof Refusal) return { errors: [{ code: error.code, field: 'boundary', reason: error.message }] };
    return { errors: [{ code: 'BOUNDARY_REFUSED', field: 'boundary', reason: 'Expected bounded, canonical JSON inputs' }] };
  }
}

export function readBoundary(projectDir) {
  try {
    const { digest: recorded, ...body } = JSON.parse(readFileSync(join(projectDir, BOUNDARY_FILE), 'utf8'));
    return recorded === digest(body) && body.schemaVersion === 1 && typeof body.productRoot === 'string' && body.wrappers ? { ...body, digest: recorded } : null;
  } catch { return null; }
}

// Why the boundary of this team root does not hold for this product and these wrappers; null when it does.
export function boundaryGap({ teamRoot, productRoot, wrappers }) {
  const boundary = readBoundary(teamRoot);
  if (!boundary) return 'no write boundary is armed, or it was changed after arming';
  if (boundary.productRoot !== productRoot) return 'the write boundary was armed for another product root';
  const named = Object.fromEntries(Object.entries(boundary.wrappers).map(([name, entry]) => [entry?.duty, name]));
  if (Object.keys(boundary.wrappers).length !== DUTIES.length || DUTIES.some(duty => named[duty] !== wrappers[duty])) return 'the write boundary names other wrappers than the roster';
  const settings = ['.claude/settings.json', '.claude/settings.local.json'].map(file => {
    try { return JSON.parse(readFileSync(join(teamRoot, file), 'utf8')); } catch { return null; }
  });
  if (settings.some(file => file?.disableAllHooks)) return 'hooks are disabled in the team root';
  const entries = Array.isArray(settings[0]?.hooks?.PreToolUse) ? settings[0].hooks.PreToolUse : [];
  const hooked = entries.some(entry => entry?.matcher === MATCHER && Array.isArray(entry.hooks) && entry.hooks.some(hook => {
    const path = hook?.type === 'command' && /^node "([^"]+)"$/.exec(hook.command ?? '')?.[1];
    return path && basename(path) === 'rw-write-boundary.mjs' && lstatSync(path, { throwIfNoEntry: false })?.isFile();
  }));
  return hooked ? null : 'the write-boundary hook is not registered, or its file is missing';
}

// A path that does not exist yet is judged by its nearest existing ancestor, so a symlink cannot move it.
function realTarget(path) {
  const pending = [];
  let current = path;
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    if (dirname(current) === current) return null;
    pending.unshift(basename(current)); current = dirname(current);
  }
  return join(realpathSync(current), ...pending);
}

// `boundary` is null when the file is missing, unreadable or edited.
export function decideWrite({ input, boundary }) {
  const allow = { decision: 'allow' }, deny = reason => ({ decision: 'deny', reason });
  if (!WRITE_TOOLS.includes(input?.tool_name) || typeof input.agent_type !== 'string') return allow;
  if (!boundary) return deny('The write boundary of this run is missing or was changed; no subagent write is allowed');
  const entry = Object.hasOwn(boundary.wrappers, input.agent_type) ? boundary.wrappers[input.agent_type] : null;
  if (!entry) return allow;
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof raw !== 'string' || !raw || typeof input.cwd !== 'string') return deny('The write names no readable target');
  const target = realTarget(resolve(input.cwd, raw)), inside = target && relative(boundary.productRoot, target);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return deny(`${input.agent_type}: the target is outside the product and outside the write boundary`);
  const path = inside.split(sep).join('/');
  return within(path, entry.writePaths) ? allow : deny(`${input.agent_type}: ${path} is outside the write boundary of this run`);
}
