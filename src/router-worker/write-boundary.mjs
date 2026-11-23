import { readFileSync, writeFileSync, lstatSync, statSync, realpathSync, readlinkSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { canonical, digest, parseJSON } from '../loop/contracts.mjs';
import { compile } from './compile.mjs';

// Runtime write boundary of one Router/Worker run. Arming freezes, per wrapper,
// the product paths its file tools may write; the PreToolUse hook judges each
// call against that file. Bash writes are outside this boundary. A batch of a
// standing team also freezes the verification commands its workers run without
// a permission prompt.
export const BOUNDARY_FILE = '.claude/rw-write-boundary.json';
const SETTINGS = '.claude/settings.json';
export const LOG_FILE = '.claude/rw-write-boundary.log.jsonl';
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit'];
// Bash is matched so that its calls are logged and, for the workers of a standing team, judged against the batch's commands.
const MATCHER = [...WRITE_TOOLS, 'Bash'].join('|');
const DUTIES = ['exec', 'check', 'guard'];
// ADR 0011, decision 12: in review the Architect may draft an ADR in the team folder, and write nothing else.
const REVIEW_TEAM_WRITES = { architect: ['decisions/drafts/**'] };
const UNRESOLVED = ['bash-writes', 'deny-under-non-default-permission-modes'];
// Owner decision of 2026-11-20: only the owner changes the team's limits, through the kit's command. No session's file tool writes them.
const LIMITS_FILE = 'profiles/team-mode.json';
const LIMITS_REASON = `${LIMITS_FILE} holds the team's limits: only the owner changes them, with: node kit/scripts/team-mode.mjs limits <LIMITS.json> --instance <instance-root>, at an interactive terminal. A limit that stopped work is reported to the owner, who decides`;

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, reason) => { if (!condition) throw new Refusal('BOUNDARY_REFUSED', reason); };
const canonicalDirectory = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && realpathSync(path) === path;
export const within = (path, grants) => grants.some(grant => grant.endsWith('/**') ? path.startsWith(grant.slice(0, -2)) : path === grant);
// A boundary written before the state was recorded is closed unless a worker may write.
export const stateOf = boundary => boundary.state ?? (Object.values(boundary.wrappers).some(entry => entry.writePaths?.length > 0) ? 'batch' : 'closed');

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

const oursHook = hook => /[\\/]rw-write-boundary\.mjs"$/.test(hook?.command ?? '');
// Why the team's settings cannot carry the hook; null when they can. Checked before a switch touches anything.
export function settingsGap(teamRoot, { hooksNeeded = true } = {}) {
  const stat = lstatSync(join(teamRoot, SETTINGS), { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile()) return `${SETTINGS} is not a regular file (a symbolic link is not followed)`;
    let settings; try { settings = JSON.parse(readFileSync(join(teamRoot, SETTINGS), 'utf8')); } catch { settings = null; }
    const plain = value => value && typeof value === 'object' && !Array.isArray(value), hooks = settings?.hooks;
    if (!plain(settings) || (hooks !== undefined && !plain(hooks)) || (hooks?.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse))
      || (hooks?.PreToolUse ?? []).some(entry => !plain(entry) || (entry.hooks !== undefined && !Array.isArray(entry.hooks))))
      return `${SETTINGS} is not a JSON object with hooks in the documented shape`;
  }
  if (hooksNeeded) for (const file of [SETTINGS, '.claude/settings.local.json']) {
    try { if (JSON.parse(readFileSync(join(teamRoot, file), 'utf8'))?.disableAllHooks) return `${file} disables all hooks; the write limits could not be enforced`; } catch { /* absent or unreadable: not this check */ }
  }
  return null;
}
function teamSettings(teamRoot, hooksNeeded) {
  need(settingsGap(teamRoot, { hooksNeeded }) === null, settingsGap(teamRoot, { hooksNeeded }));
  const path = join(teamRoot, SETTINGS);
  return { path, settings: lstatSync(path, { throwIfNoEntry: false }) ? JSON.parse(readFileSync(path, 'utf8')) : {} };
}
// The team's PreToolUse entries without our hook. A hook that shares an entry with ours is kept.
const holdsOurs = entry => Array.isArray(entry.hooks) && entry.hooks.some(oursHook);
const withoutOurs = entries => entries.map(entry => holdsOurs(entry) ? { ...entry, hooks: entry.hooks.filter(hook => !oursHook(hook)) } : entry)
  .filter((entry, i) => !holdsOurs(entries[i]) || entry.hooks.length > 0);

// Why this hook file cannot be registered; null when it can.
export const hookGap = hookPath => typeof hookPath === 'string' && isAbsolute(hookPath) && !/["$`\\]/.test(hookPath) && lstatSync(hookPath, { throwIfNoEntry: false })?.isFile()
  ? null : 'The write-boundary hook is missing from the kit, or the kit\'s path holds a character that cannot be quoted in a hook command';

// A standing team between batches: the hook is registered and the three workers may write nothing.
// Any other agent of the team is not judged.
export function standBoundary({ teamRoot, productRoot, wrappers, hookPath }) {
  need(DUTIES.every(duty => typeof wrappers?.[duty] === 'string' && wrappers[duty]) && new Set(DUTIES.map(duty => wrappers[duty])).size === DUTIES.length, 'One wrapper per duty is required');
  need(hookGap(hookPath) === null, hookGap(hookPath));
  const { path, settings } = teamSettings(teamRoot, true), existing = settings.hooks?.PreToolUse ?? [];
  const body = { schemaVersion: 1, state: 'closed', productRoot, wrappers: Object.fromEntries(DUTIES.map(duty => [wrappers[duty], { duty, writePaths: [], commands: [] }])) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(join(teamRoot, BOUNDARY_FILE), JSON.stringify({ ...body, digest: digest(body) }, null, 2) + '\n');
  writeFileSync(path, JSON.stringify({ ...settings, hooks: { ...settings.hooks, PreToolUse: [...withoutOurs(existing), { matcher: MATCHER, hooks: [{ type: 'command', command: `node "${hookPath}"` }] }] } }, null, 2) + '\n');
}

// A batch opens in a standing team: the closed boundary becomes the batch's, with the exec worker's write
// paths. The wrappers and the product are the ones the closed boundary already names; nothing else is trusted.
export function openBoundary({ teamRoot, productRoot, writePaths, commands = [] }) {
  const closed = readBoundary(teamRoot);
  need(closed && closed.productRoot === productRoot && stateOf(closed) === 'closed', 'The team has no closed write boundary for this product; a batch may be open or in review, or the boundary was changed');
  need(Array.isArray(writePaths) && writePaths.length > 0 && writePaths.every(path => typeof path === 'string' && path), 'A batch needs at least one write path');
  need(Array.isArray(commands) && commands.every(command => typeof command === 'string' && command), 'The commands of a batch must be a list of commands');
  // The Guardian reads; the two workers that run the verification commands are approved for them.
  const body = { schemaVersion: 1, state: 'batch', productRoot, wrappers: Object.fromEntries(Object.entries(closed.wrappers).map(([name, entry]) => [name, { duty: entry.duty, writePaths: entry.duty === 'exec' ? [...new Set(writePaths)].sort() : [],
    commands: entry.duty === 'guard' ? [] : [...new Set(commands)].sort() }])) };
  writeFileSync(join(teamRoot, BOUNDARY_FILE), JSON.stringify({ ...body, digest: digest(body) }, null, 2) + '\n');
  return { digest: digest(body), wrappers: Object.fromEntries(Object.entries(body.wrappers).map(([name, entry]) => [entry.duty, name])) };
}
// The batch or its review is over, or could not start: no worker may write again, and the reviewers leave the boundary.
export function closeBoundary({ teamRoot }) {
  const open = readBoundary(teamRoot);
  need(open, 'The write boundary is missing or was changed');
  const body = { schemaVersion: 1, state: 'closed', productRoot: open.productRoot, wrappers: Object.fromEntries(Object.entries(open.wrappers).filter(([, entry]) => entry.duty !== 'review')
    .map(([name, entry]) => [name, { duty: entry.duty, writePaths: [], commands: [] }])) };
  writeFileSync(join(teamRoot, BOUNDARY_FILE), JSON.stringify({ ...body, digest: digest(body) }, null, 2) + '\n');
}
// ADR 0011, decision 4: a batch whose changes need a review. The workers write and run nothing; each reviewer
// (`reviewers`: reviewer -> wrapper) is judged too: no product write, no shell, in the team folder only its drafts.
// Decision 7: a periodic review, between batches, enters the same state from a closed boundary.
export function reviewBoundary({ teamRoot, runId, reviewers, periodic = false }) {
  const open = readBoundary(teamRoot);
  need(open && (periodic ? ['closed', 'review'] : ['batch', 'review']).includes(stateOf(open)), periodic ? 'The write boundary is missing, was changed, or a batch is open' : 'The write boundary is missing, was changed, or no batch is open');
  const workers = Object.entries(open.wrappers).filter(([, entry]) => DUTIES.includes(entry.duty));
  need(Object.values(reviewers).every(name => typeof name === 'string' && name && !workers.some(([worker]) => worker === name)) && new Set(Object.values(reviewers)).size === Object.keys(reviewers).length,
    'Each reviewer needs a wrapper of its own, which is not a worker\'s');
  const body = { schemaVersion: 1, state: 'review', runId, ...(periodic ? { periodic: true } : {}), productRoot: open.productRoot, teamRoot: realpathSync(teamRoot), wrappers: Object.fromEntries([
    ...workers.map(([name, entry]) => [name, { duty: entry.duty, writePaths: [], commands: [] }]),
    ...Object.entries(reviewers).map(([reviewer, name]) => [name, { duty: 'review', reviewer, writePaths: [], commands: [], teamWritePaths: REVIEW_TEAM_WRITES[reviewer] ?? [] }])]) };
  writeFileSync(join(teamRoot, BOUNDARY_FILE), JSON.stringify({ ...body, digest: digest(body) }, null, 2) + '\n');
  return { digest: digest(body) };
}

// The team leaves Router/Worker mode: the hook is unregistered and the boundary removed. Other settings stay.
export function dropBoundary({ teamRoot }) {
  rmSync(join(teamRoot, BOUNDARY_FILE), { force: true });
  const { path, settings } = teamSettings(teamRoot, false), existing = settings.hooks?.PreToolUse ?? [];
  if (!existing.some(holdsOurs)) return;
  const { PreToolUse, ...otherHooks } = settings.hooks, { hooks, ...rest } = settings, kept = withoutOurs(existing);
  const nextHooks = kept.length ? { ...otherHooks, PreToolUse: kept } : otherHooks, next = Object.keys(nextHooks).length ? { ...rest, hooks: nextHooks } : rest;
  // A settings file that held nothing but our hook is removed with it.
  if (Object.keys(next).length) writeFileSync(path, JSON.stringify(next, null, 2) + '\n'); else rmSync(path);
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

// A refused command is kept for the owner's report; values that look like secrets never reach the log.
export const redacted = command => command
  .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASS(?:WORD)?|KEY|AUTH|CRED(?:ENTIAL)?S?)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1=<redacted>')
  .replace(/(-H\s*["']?(?:Authorization|Cookie|X-Api-Key)\s*:\s*)[^"'\n]*/gi, '$1<redacted>')
  .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://<redacted>@')
  .replace(/[A-Za-z0-9+_=-]{32,}/g, '<redacted>');

// One log line per hook call: who called which tool and what was decided. No path. A worker's shell command that was
// refused is kept as text, so that "after" can report it to the owner.
export function logEntry({ input, boundary, decision, at }) {
  const tool = typeof input?.tool_name === 'string' ? input.tool_name : null, agentType = typeof input?.agent_type === 'string' ? input.agent_type : null;
  const entry = boundary && agentType !== null && Object.hasOwn(boundary.wrappers, agentType) ? boundary.wrappers[agentType] : null;
  const judged = agentType !== null && (WRITE_TOOLS.includes(tool) ? !boundary || entry !== null : tool === 'Bash' && (!boundary || Array.isArray(entry?.commands)));
  const command = tool === 'Bash' && decision === 'deny' && Array.isArray(entry?.commands) && typeof input.tool_input?.command === 'string' ? redacted(input.tool_input.command.trim()).slice(0, 300) : null;
  return { at, tool, agentType, judged, decision, ...(command ? { command } : {}) };
}

// A path that cannot be resolved (a dangling link, a file taken for a folder, no permission) is judged as written.
// A dangling link is followed by its text, so a Write through it is judged where it would create the file.
const linkedTo = path => { let current = path; for (let hops = 0; hops < 40; hops++) { try { if (!lstatSync(current).isSymbolicLink()) return current; current = resolve(dirname(current), readlinkSync(current)); } catch { return current; } } return current; };
const resolvedOr = path => { try { return realTarget(path) ?? linkedTo(path); } catch { return linkedTo(path); } };
const statOf = path => { try { return statSync(path); } catch { return null; } };

// The call writes the team's limits file: by its path as resolved, whatever its case, or as the same file under another name.
function writesLimits(input, projectDir) {
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof projectDir !== 'string' || !isAbsolute(projectDir) || typeof raw !== 'string' || !raw) return false;
  const target = resolvedOr(resolve(typeof input.cwd === 'string' ? input.cwd : projectDir, raw)), limits = resolvedOr(join(projectDir, LIMITS_FILE));
  if (target.toLowerCase() === limits.toLowerCase()) return true;
  const [a, b] = [target, limits].map(statOf);
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

// `boundary` is null when the file is missing, unreadable or edited. 'allow' leaves the call to the session's own
// permissions; 'approve' answers the permission prompt for it; 'deny' refuses it.
// `projectDir` is the team's root; its limits file is refused to every session.
export function decideCall({ input, boundary, projectDir }) {
  const allow = { decision: 'allow' }, deny = reason => ({ decision: 'deny', reason });
  if (input?.tool_name === 'Bash') return decideCommand({ input, boundary, allow, deny });
  if (!WRITE_TOOLS.includes(input?.tool_name)) return allow;
  if (writesLimits(input, projectDir)) return deny(LIMITS_REASON);
  if (typeof input.agent_type !== 'string') return allow;
  if (!boundary) return deny('The write boundary of this run is missing or was changed; no subagent write is allowed');
  const entry = Object.hasOwn(boundary.wrappers, input.agent_type) ? boundary.wrappers[input.agent_type] : null;
  if (!entry) return allow;
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof raw !== 'string' || !raw || typeof input.cwd !== 'string') return deny('The write names no readable target');
  const target = realTarget(resolve(input.cwd, raw));
  if (entry.duty === 'review') {
    const inTeam = target && typeof boundary.teamRoot === 'string' ? relative(boundary.teamRoot, target) : null;
    const drafts = entry.teamWritePaths ?? [];
    return inTeam && !inTeam.startsWith('..') && !isAbsolute(inTeam) && within(inTeam.split(sep).join('/'), drafts) ? allow
      : deny(`${input.agent_type}: a reviewer writes nothing in the product${drafts.length ? `, and in the team folder only ${drafts.join(', ')}` : ' or the team folder'}`);
  }
  const inside = target && relative(boundary.productRoot, target);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return deny(`${input.agent_type}: the target is outside the product and outside the write boundary`);
  const path = inside.split(sep).join('/');
  return within(path, entry.writePaths) ? allow : deny(`${input.agent_type}: ${path} is outside the write boundary of this run`);
}

// A product root that can be written inside double quotes in a shell command, and one that needs no quotes at all.
export const quotable = root => typeof root === 'string' && !/["$`\\!\x00-\x1f\x7f]/.test(root);
export const UNQUOTABLE = 'The path of the product repository holds a character that cannot be written inside a quoted shell command (" $ ` \\ !); the workers could run no command there';
const bare = root => /^[A-Za-z0-9_\/.+@%,:=-]+$/.test(root);

// The shell of a standing team's worker. In a batch it runs the verification commands the owner confirmed and the
// batch froze, from the product root, and nothing else: a command with anything added is another command. A wrapper
// whose boundary carries no command list (a disposable launch, a boundary written before the list existed) is not
// judged. With no readable boundary nobody knows who the workers are: no subagent's shell runs, as for its writes.
function decideCommand({ input, boundary, allow, deny }) {
  if (typeof input.agent_type !== 'string') return allow;
  if (!boundary) return deny('The write boundary of this run is missing or was changed; no subagent runs a shell command');
  const entry = Object.hasOwn(boundary.wrappers, input.agent_type) ? boundary.wrappers[input.agent_type] : null;
  if (!entry || !Array.isArray(entry.commands)) return allow;
  if (entry.duty === 'review') return deny(`${input.agent_type}: a reviewer runs no shell command; the kit ran the verification commands and put their output in the brief`);
  // Spaces and line breaks around the text change nothing for a shell; any other character is part of the command.
  const root = boundary.productRoot, text = typeof input.tool_input?.command === 'string' ? input.tool_input.command.replace(/^[ \t\n]+|[ \t\n]+$/g, '') : '';
  const forms = command => [...(input.cwd === root ? [command] : []), ...(quotable(root) ? [`cd "${root}" && ${command}`] : []), ...(bare(root) ? [`cd ${root} && ${command}`] : [])];
  const unsandboxed = input.tool_input?.dangerouslyDisableSandbox;
  if ((unsandboxed === undefined || unsandboxed === false) && entry.commands.some(command => forms(command).includes(text))) return { decision: 'approve' };
  return deny(entry.commands.length
    ? `${input.agent_type}: in a batch the shell runs only the verification commands confirmed for this team, from the product root, each exactly as written and inside the sandbox if there is one: ${entry.commands.map(command => `cd "${root}" && ${command}`).join('  |  ')}`
    : `${input.agent_type}: no batch is open, or this worker runs no command in it; the shell is closed`);
}
