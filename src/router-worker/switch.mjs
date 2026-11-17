import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, bytesDigest, parseJSON } from '../loop/contracts.mjs';
import { draftTeam } from './draft.mjs';
import { stageTeam } from './stage.mjs';
import { makeLive } from './activate.mjs';
import { instanceOf } from './roots.mjs';
import { git, isRepositoryRoot, readLease, acquireLease, releaseLease } from './lease.mjs';

// ADR 0010: a deployed team is switched between specialist and Router/Worker mode. The live mode's own
// files (roster, delivery role files, wrappers, mode profile) are moved into holiday/<mode>/ and the
// other mode's are put in place. Shared history is never moved. The owner confirms the proposal's digest.
// Every move is announced in a journal first, so a switch that dies half-way can be rolled back.
const MODES = ['specialist', 'router-worker'];
const HOLIDAY = 'holiday', JOURNAL = `${HOLIDAY}/.switch-in-progress.json`, MANIFEST = 'manifest.json';
const MODE_FILE = 'profiles/team-mode.json', ROSTER = 'agents/roster.md', REGISTRY = '.claude/agents', LEDGER = 'pm-decisions.md';
// Roles of the team in either mode, and the team's ledgers: their files under agents/ are shared, never packed.
const SHARED_ROLES = ['pm', 'architect', 'coach', 'auditor', 'security', 'chaos'];
const SHARED_AGENT_FILES = [...SHARED_ROLES, 'lessons', 'lifecycle', 'self-improvement', 'templates'].map(name => `agents/${name}.md`);
const IN_PROGRESS = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
export const DEFAULT_LIMITS = { attemptsPerTicket: 1, outputAllowancePerTicket: 15000, guardianOutputShare: 6000, authorizationPerTicket: 200000 };
const LIVE = { active: 'Live: Router/Worker mode of this team, confirmed by the owner at the switch', description: 'standing mode',
  roster: 'the specialist roster is packed under holiday/specialist.' };

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, reason, code = 'SWITCH_REFUSED') => { if (!condition) throw new Refusal(code, reason); };
const refusal = error => ({ errors: [{ code: error instanceof Refusal ? error.code : 'SWITCH_REFUSED', field: 'switch', reason: String(error?.message ?? 'The switch could not be prepared') }] });
const isFile = path => Boolean(lstatSync(path, { throwIfNoEntry: false })?.isFile());
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').some(part => part === '' || part === '.' || part === '..');
const inRegistry = path => path.startsWith(`${REGISTRY}/`);
const GOVERNANCE_FILES = SHARED_ROLES.map(role => `agents/${role}.md`);
// What may be a mode's own file. Anything else named by a profile or a manifest is refused, not moved.
const OWN = {
  specialist: path => path === ROSTER || path === MODE_FILE || inRegistry(path) || (/^agents\/[^/]+\.md$/.test(path) && !SHARED_AGENT_FILES.includes(path)),
  'router-worker': path => path === ROSTER || path === MODE_FILE || inRegistry(path) || /^agents\/(worker-(exec|check|guard)|router-worker-(contract|router))\.md$/.test(path),
};
// What a first switch into Router/Worker may create: the mode's own files, and a governance role file that is missing.
const installable = path => OWN['router-worker'](path) || GOVERNANCE_FILES.includes(path);

function registryFiles(instance) {
  const found = [], walk = relative => {
    for (const entry of readdirSync(join(instance, relative), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${relative}/${entry.name}`); else if (entry.isFile()) found.push(`${relative}/${entry.name}`);
    }
  };
  if (exists(join(instance, REGISTRY))) walk(REGISTRY);
  return found;
}

function currentMode(instance) {
  const mode = readJSON(join(instance, MODE_FILE));
  return mode?.mode === 'router-worker' && mode.status === 'live' ? { name: 'router-worker', profile: mode } : { name: 'specialist', profile: null };
}

// The specialist team's own files: its roster, everything in the wrapper registry, and the role file the
// roster's own table names for each role that is not the PM or a governance role.
function specialistFiles(instance) {
  // An unanswered placeholder such as {{NAME | default:X}} holds a pipe of its own; it is one cell.
  // An escaped pipe is text; a linked cell names its target.
  const cells = line => line.replace(/\{\{[^}]*\}\}/g, 'placeholder').replace(/\\\|/g, ' ').split('|').slice(1, -1)
    .map(cell => cell.trim().replace(/^\[[^\]]*\]\(([^)]*)\)$/, '$1').replace(/^[`*_]+|[`*_]+$/g, ''));
  const lines = readFileSync(join(instance, ROSTER), 'utf8').split('\n'), roles = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].startsWith('|') ? cells(lines[i]).map(cell => cell.toLowerCase()) : [], id = header.findIndex(cell => cell === 'role id' || cell === 'role'), file = header.indexOf('role file');
    if (id < 0 || file < 0) continue;
    tables++;
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) roles.push([cells(lines[j])[id], cells(lines[j])[file]]);
  }
  need(tables > 0, `${ROSTER} has no table with a role column and a "Role file" column; the specialist team's role files cannot be told from it`);
  // A role whose file cannot be read from the table would stay live in the other mode, so the switch stops instead.
  const delivery = roles.filter(([role]) => role && !SHARED_ROLES.includes(role)).map(([role, path]) => {
    need(safePath(path) && /^agents\/[^/]+\.md$/.test(path) && !SHARED_AGENT_FILES.includes(path) && path !== ROSTER, `${ROSTER} does not name a role file under agents/ for the role ${role}`);
    return path;
  });
  return [...new Set([ROSTER, MODE_FILE, ...registryFiles(instance), ...delivery])].filter(path => isFile(join(instance, path))).sort();
}

function checkProduct(productRoot) {
  need(typeof productRoot === 'string' && isRepositoryRoot(productRoot), 'The product root must be the top of its own Git repository');
  const status = git(productRoot, 'status', '--porcelain'), gitDir = git(productRoot, 'rev-parse', '--absolute-git-dir')?.trim();
  need(status !== null && gitDir, 'The state of the product repository cannot be read');
  const busy = IN_PROGRESS.filter(name => exists(join(gitDir, name)));
  need(!busy.length, `A Git operation is in progress in the product repository (${busy.join(', ')})`);
  const changed = status.split('\n').filter(Boolean).map(line => line.slice(3));
  need(!changed.length, `The product repository has uncommitted changes (${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}); commit or discard them before switching`);
  need(readLease({ productRoot }).status === 'free', 'A batch holds the lock on the product repository; close it before switching');
}

// The product repository bootstrap recorded in the project profile; null when that was never answered.
function recordedProduct(instance) {
  let text; try { text = readFileSync(join(instance, 'profiles/project.md'), 'utf8'); } catch { return null; }
  const value = /^\s*product_repo_path:\s*"?([^"\n]+?)"?\s*$/m.exec(text)?.[1];
  if (!value || value.includes('{{')) return null;
  try { return realpathSync(resolve(instance, value)); } catch { return resolve(instance, value); }
}

function limitsOf(request) {
  const given = request?.limits ?? {};
  need(given && typeof given === 'object' && !Array.isArray(given) && Object.keys(given).every(key => Object.hasOwn(DEFAULT_LIMITS, key))
    && Object.values(given).every(value => Number.isSafeInteger(value) && value >= 1) && (given.attemptsPerTicket ?? 1) <= 3, 'limits may only set the known limits to positive integers');
  return { ...DEFAULT_LIMITS, ...given };
}

// A packed team, checked: every file the manifest names may belong to that mode, is there, and is unchanged.
function packedTeam(instance, mode) {
  const folder = join(instance, HOLIDAY, mode), manifest = readJSON(join(folder, MANIFEST));
  if (!manifest) return null;
  need(manifest.mode === mode && Array.isArray(manifest.files), `holiday/${mode}/${MANIFEST} is not a manifest of a packed ${mode} team`);
  for (const entry of manifest.files) {
    need(safePath(entry?.path) && OWN[mode](entry.path), `holiday/${mode}/${MANIFEST} names ${entry?.path}, which is not a file of a ${mode} team`);
    need(isFile(join(folder, entry.path)) && bytesDigest(readFileSync(join(folder, entry.path))) === entry.digest, `holiday/${mode}/${entry.path} is missing or was edited after it was packed`);
  }
  return { folder, manifest, digest: digest(manifest) };
}

// Everything the switch would do, without doing it.
function plan({ to, request, teamRoot, instanceRoot, productRoot }) {
  need(MODES.includes(to), `The mode must be one of: ${MODES.join(', ')}`);
  need(request && typeof request === 'object' && !Array.isArray(request), 'The request must be a JSON object: {"spec"?: {...}, "limits"?: {...}}');
  const kit = resolve(teamRoot);
  let instance;
  try { instance = instanceOf(kit, instanceRoot); } catch (error) { need(false, `Router/Worker mode needs the two-root layout (${error.message}); migrate the deployment with scripts/migrate-to-instance.sh first`); }
  need(instance, 'An instance root is required');
  need(!exists(join(instance, JOURNAL)), 'An earlier switch was interrupted; roll it back first with: team-mode.mjs switch recover --instance <instance-root>', 'SWITCH_INTERRUPTED');
  const live = currentMode(instance);
  need(live.name !== to, `The team is already in ${to} mode`);

  // The live mode's own files, which go on holiday.
  let pack;
  if (live.name === 'specialist') pack = specialistFiles(instance);
  else {
    need(Array.isArray(live.profile.ownFiles), 'The mode profile does not list the files of the Router/Worker team');
    const foreign = live.profile.ownFiles.filter(path => !safePath(path) || !OWN['router-worker'](path));
    need(!foreign.length, `The mode profile lists files that are not Router/Worker files: ${foreign.slice(0, 5).join(', ')}`);
    pack = [...new Set([...live.profile.ownFiles, ...registryFiles(instance)])].filter(path => isFile(join(instance, path))).sort();
  }

  // A packed team is never overwritten. A stray file in the folder (a .DS_Store) is not a packed team.
  const taken = exists(join(instance, HOLIDAY, live.name, MANIFEST)) ? [MANIFEST] : pack.filter(path => exists(join(instance, HOLIDAY, live.name, path)));
  need(!taken.length, `holiday/${live.name} already holds a packed team (${taken.slice(0, 5).join(', ')}); it is never overwritten. Move it away by hand if it is not needed`);

  const packed = packedTeam(instance, to), base = { schemaVersion: 1, stage: 'switch-proposed', from: live.name, to, pack };
  // The team is bound to one product repository: the one its Router/Worker spec names.
  const boundSpec = live.profile?.spec ?? (to === 'router-worker' && packed ? readJSON(join(packed.folder, MODE_FILE))?.spec : null) ?? request.spec;
  need(boundSpec?.project?.productRoot === productRoot, 'The product root given is not the product repository this team is bound to');
  const recorded = live.profile || packed ? null : recordedProduct(instance);
  need(recorded === null || recorded === productRoot, 'The product root given is not the product repository recorded in profiles/project.md');
  checkProduct(productRoot);

  if (packed) {
    need(to === 'specialist' || request.spec === undefined || digest(request.spec) === digest(boundSpec),
      'A packed Router/Worker team exists and comes back as it was packed; to draft another one, move holiday/router-worker away first');
    const install = packed.manifest.files.map(entry => entry.path).sort(), blocked = install.filter(path => exists(join(instance, path)) && !pack.includes(path));
    need(!blocked.length, `These files are in the way of the packed ${to} team: ${blocked.slice(0, 5).join(', ')}`);
    const profile = to === 'router-worker' ? readJSON(join(packed.folder, MODE_FILE)) : null;
    need(request.limits === undefined, `A packed team comes back with the limits it was packed with${profile ? ` (${JSON.stringify(profile.limits)})` : ''}; to set others, move holiday/${to} away and switch with a new request`);
    return { kit, instance, live, kind: 'restore', packed,
      body: { ...base, ...(profile ? { dispatch: profile.dispatch, limits: profile.limits, staffing: profile.staffing } : {}), install, kept: [], restoreManifestDigest: packed.digest } };
  }
  need(to === 'router-worker', 'No packed specialist team under holiday/specialist');
  const spec = request.spec;
  need(spec && typeof spec === 'object', 'A Router/Worker team spec is required: {"spec": {...}, "limits"?: {...}}');
  const limits = limitsOf(request), drafted = draftTeam(spec, { teamRoot: kit, instanceRoot: instance });
  need(!drafted.errors, `The team cannot be drafted: ${drafted.errors?.[0]?.reason}`);
  const draft = drafted.draft, scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rw-switch-')));
  // A full copy is staged and validated before the standing team is touched.
  try {
    const staged = stageTeam(spec, draft, join(scratch, 'team.rw-staging'), { teamRoot: kit, instanceRoot: instance });
    need(!staged.errors, `Staging the team failed: ${staged.errors?.[0]?.reason}`);
    need(staged.stage === 'staged-structurally-validated', `The staged team is ${staged.stage}: ${staged.validator.failures.slice(0, 3).join(' | ')}`);
    need(staged.unstaffed.length === 0, `Enabled workflow duties are unstaffed: ${staged.unstaffed.map(entry => `${entry.workflow}/${entry.role}`).slice(0, 8).join(', ')}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  // A file of the draft that is already there and is not being packed stays as the team wrote it. Only a shared
  // (governance) role file may be in that position; anything else is in the way.
  const present = Object.keys(draft.files).filter(path => exists(join(instance, path)) && !pack.includes(path)).sort();
  const blocked = present.filter(path => OWN['router-worker'](path));
  need(!blocked.length, `These files are in the way of the Router/Worker team: ${blocked.slice(0, 5).join(', ')}`);
  const install = Object.keys(draft.files).filter(path => !present.includes(path)).sort(), foreign = install.filter(path => !safePath(path) || !installable(path));
  need(!foreign.length, `The draft would create files that are not Router/Worker files: ${foreign.slice(0, 5).join(', ')}`);
  return { kit, instance, live, kind: 'draft', draft, spec, limits,
    body: { ...base, dispatch: 'engine', limits, staffing: { ...spec.profiles, ...(spec.governance ?? {}) }, install, kept: present, specDigest: digest(spec), draftDigest: draft.digest } };
}

export function proposeSwitch(options) {
  try { const { body } = plan(options); return { ...body, digest: digest(body) }; } catch (error) { return refusal(error); }
}

function validateDeployment(kit, instance) {
  const run = spawnSync('bash', [join(kit, 'scripts/validate-team.sh'), '--mode', 'deployment', instance],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C' } });
  const lines = (run.stdout ?? '').split('\n'), verdict = (lines.filter(line => line.startsWith('RESULT: ')).pop() ?? '').slice('RESULT: '.length);
  return { ok: run.status === 0 && verdict.startsWith('DEPLOYMENT-STRUCTURALLY-COMPLETE'), verdict: `${verdict || 'no verdict'} ${lines.filter(line => line.startsWith('FAIL - ')).slice(0, 3).join(' | ')}`.trim() };
}

const prune = folder => { try { rmdirSync(folder); return true; } catch { return false; } };
// Removes directories a move left empty, from the deepest up to (not including) `stop`.
function pruneUp(from, stop) { for (let dir = dirname(from); dir.startsWith(stop) && dir !== stop && prune(dir); dir = dirname(dir)); }

// Undoes a journaled switch, whether it was this call's or one that died earlier. Only files the journal
// announced are touched, and a file is moved back only where its place is empty.
function rollBack(instance, journal) {
  const out = join(instance, HOLIDAY, journal.from), into = join(instance, HOLIDAY, journal.to);
  // What the switch put in place goes first. A path it also packed still holds the old file unless that file is on holiday.
  for (const path of journal.install) {
    const live = join(instance, path);
    if (!exists(live) || (journal.pack.includes(path) && !exists(join(out, path)))) continue;
    if (journal.kind === 'restore' && !exists(join(into, path))) { mkdirSync(dirname(join(into, path)), { recursive: true }); renameSync(live, join(into, path)); }
    else if (journal.kind === 'draft') rmSync(live, { force: true });
  }
  for (const path of journal.pack) {
    const live = join(instance, path), away = join(out, path);
    if (exists(away) && !exists(live)) { mkdirSync(dirname(live), { recursive: true }); renameSync(away, live); pruneUp(away, out); }
  }
  rmSync(join(out, MANIFEST), { force: true }); prune(out);
  // A restore that died after it cleared the holiday folder: the folder gets its manifest back.
  if (journal.kind === 'restore' && journal.restoreManifest && exists(into) && !exists(join(into, MANIFEST))) writeFileSync(join(into, MANIFEST), JSON.stringify(journal.restoreManifest, null, 2) + '\n');
  // The switch's own lock. A switch that died before it recorded the lock is known by this team's name and by its start time.
  const held = journal.productRoot ? readLease({ productRoot: journal.productRoot }).lease : null;
  const ours = held && (journal.lease ? held.digest === journal.lease : held.teamRoot === instance && held.acquiredAt >= journal.startedAt);
  const released = ours ? releaseLease({ productRoot: journal.productRoot, lease: held.digest }) : null;
  need(!released?.errors, `The team was put back, but the lock on the product repository could not be released (${released?.errors?.[0]?.reason}); then run: team-mode.mjs switch recover --instance <instance-root>`, 'SWITCH_INTERRUPTED');
  rmSync(join(instance, `${JOURNAL}.tmp`), { force: true }); rmSync(join(instance, JOURNAL), { force: true }); prune(join(instance, HOLIDAY));
}

export function recoverSwitch({ teamRoot, instanceRoot }) {
  try {
    const instance = instanceOf(resolve(teamRoot), instanceRoot);
    need(instance, 'An instance root is required');
    need(exists(join(instance, JOURNAL)), 'There is no interrupted switch to roll back');
    const journal = readJSON(join(instance, JOURNAL));
    const unreadable = 'The journal of the interrupted switch cannot be read; restore the team by hand from holiday/';
    need(journal && MODES.includes(journal.from) && MODES.includes(journal.to) && journal.from !== journal.to && ['draft', 'restore'].includes(journal.kind)
      && Array.isArray(journal.pack) && Array.isArray(journal.install) && [...journal.pack, ...journal.install].every(safePath)
      && (journal.lease === null || typeof journal.lease === 'string') && typeof journal.productRoot === 'string' && typeof journal.startedAt === 'string', unreadable);
    // The journal is obeyed only for files that may belong to the two modes; it never moves or deletes shared history.
    const foreign = [...journal.pack.filter(path => !OWN[journal.from](path)), ...journal.install.filter(path => !(journal.kind === 'draft' ? installable(path) : OWN[journal.to](path)))];
    need(!foreign.length, `The journal names files that are not a mode's own (${foreign.slice(0, 5).join(', ')}); restore the team by hand from holiday/`);
    rollBack(instance, journal);
    appendFileSync(join(instance, LEDGER), `${new Date().toISOString().slice(0, 10)} MODE SWITCH ROLLED BACK: the interrupted switch from ${journal.from} to ${journal.to} was undone by switch recover; the team is in ${journal.from} mode.\n`);
    const record = { schemaVersion: 1, stage: 'switch-rolled-back', mode: journal.from, abandoned: journal.to };
    return { ...record, digest: digest(record) };
  } catch (error) { return refusal(error); }
}

export function switchMode({ confirm, validate, atTerminal, ...options }) {
  let planned;
  try { planned = plan(options); } catch (error) { return refusal(error); }
  const { instance, kit, live, body, kind, packed, draft, spec, limits } = planned, proposalDigest = digest(body), to = body.to, productRoot = options.productRoot;
  if (confirm !== proposalDigest) return { errors: [{ code: 'SWITCH_NOT_CONFIRMED', field: 'switch', reason: 'A switch is confirmed by the digest of its proposal; this digest is not the current proposal' }] };

  const journalPath = join(instance, JOURNAL), out = join(instance, HOLIDAY, live.name), into = join(instance, HOLIDAY, to);
  const started = { schemaVersion: 1, from: live.name, to, kind, pack: body.pack, install: body.install, lease: null, productRoot, startedAt: new Date().toISOString(),
    ...(kind === 'restore' ? { restoreManifest: packed.manifest } : {}) };
  // The journal comes before the lock, so a switch that dies holding the lock can always be found and undone.
  try { mkdirSync(join(instance, HOLIDAY), { recursive: true }); writeFileSync(journalPath, JSON.stringify(started, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { prune(join(instance, HOLIDAY)); return refusal(new Refusal('SWITCH_REFUSED', `The switch could not be started: ${error?.code ?? error?.message}`)); }
  // The product is locked for the length of the switch, so no batch can start half-way through it.
  const lock = acquireLease({ teamRoot: instance, productRoot });
  if (lock.errors) {
    rmSync(journalPath, { force: true }); prune(join(instance, HOLIDAY));
    return refusal(new Refusal('SWITCH_REFUSED', 'The lock on the product repository could not be taken; a batch may have started'));
  }
  const lease = lock.lease.digest, journal = { ...started, lease }, at = new Date().toISOString();
  let verdict = 'restored-as-packed', leftInHoliday = [];
  try {
    writeFileSync(`${journalPath}.tmp`, JSON.stringify(journal, null, 2) + '\n'); renameSync(`${journalPath}.tmp`, journalPath);
    // 1. The live mode's own files go on holiday.
    const manifest = { schemaVersion: 1, mode: live.name, files: [] };
    for (const path of body.pack) {
      const from = join(instance, path), away = join(out, path);
      manifest.files.push({ path, digest: bytesDigest(readFileSync(from)) });
      mkdirSync(dirname(away), { recursive: true }); renameSync(from, away);
    }
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

    // 2. The other mode's files are put in place.
    if (kind === 'restore') {
      for (const path of body.install) { mkdirSync(dirname(join(instance, path)), { recursive: true }); renameSync(join(packed.folder, path), join(instance, path)); }
    } else {
      for (const path of body.install) { mkdirSync(dirname(join(instance, path)), { recursive: true }); writeFileSync(join(instance, path), draft.files[path], { flag: 'wx' }); }
      makeLive(instance, body.install, LIVE);
      // Governance role files the switch had to create are shared from now on: they are not the mode's own.
      const mode = { ...parseJSON(draft.files[MODE_FILE]), status: 'live', launchable: true, dispatch: 'engine', limits, staffing: body.staffing, spec,
        specDigest: body.specDigest, draftDigest: draft.digest, confirmedProposal: proposalDigest, ownFiles: body.install.filter(OWN['router-worker']) };
      writeFileSync(join(instance, MODE_FILE), JSON.stringify(mode, null, 2) + '\n');
    }

    // 3. A Router/Worker team must be a complete deployment where it stands; the kit may have changed since it
    // was packed. A specialist team comes back byte for byte as it was packed.
    if (to === 'router-worker') {
      const checked = (validate ?? (() => validateDeployment(kit, instance)))(instance);
      verdict = checked.verdict;
      need(checked.ok, `The switched team fails the deployment validator: ${checked.verdict}`);
    }
    // 4. What is live is no longer on holiday. Anything else found in that folder is left where it is.
    if (kind === 'restore') {
      rmSync(join(into, MANIFEST), { force: true });
      for (const path of body.install) pruneUp(join(into, path), into);
      if (!prune(into)) leftInHoliday = readdirSync(into).sort();
    }
    // 5. The lock is given back and the ledger written while the journal still stands: a death here is found and undone.
    need(releaseLease({ productRoot, lease }).status === 'free', 'The lock on the product repository could not be released');
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} MODE SWITCH: from ${live.name} to ${to}; proposal ${proposalDigest} was confirmed ${atTerminal === true ? 'by its code, typed at an interactive terminal' : 'by a program that called the switch directly, not at a terminal'}. ${body.pack.length} file(s) packed under holiday/${live.name}.\n`);
    rmSync(journalPath);
  } catch (error) {
    try { rollBack(instance, journal); } catch (undo) {
      return { errors: [{ code: 'SWITCH_INTERRUPTED', field: 'switch', reason: `The switch failed (${error?.message}) and could not be rolled back (${undo?.message}); run: team-mode.mjs switch recover --instance <instance-root>` }] };
    }
    return refusal(error);
  }
  const record = { schemaVersion: 1, stage: 'mode-switched', mode: to, from: live.name, proposalDigest, packed: body.pack, installed: body.install, kept: body.kept, leftInHoliday, validator: verdict, switchedAt: at };
  return { ...record, digest: digest(record) };
}

// The limits of a live Router/Worker team are set at the switch; this changes them afterwards, by the same confirmation.
function planLimits({ teamRoot, instanceRoot, limits }) {
  const no = reason => { throw new Refusal('LIMITS_REFUSED', reason); };
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { no(`The two-root layout is required (${error.message})`); }
  if (!instance) no('An instance root is required');
  if (exists(join(instance, JOURNAL))) no('A switch was interrupted; roll it back first with: team-mode.mjs switch recover --instance <instance-root>');
  const live = currentMode(instance);
  if (live.name !== 'router-worker') no('The team is not in Router/Worker mode; limits are set with the switch');
  if (!limits || typeof limits !== 'object') no('The limits to change are required: {"outputAllowancePerTicket": 20000}');
  try { limitsOf({ limits }); } catch (error) { no(error.message); }
  const next = { ...live.profile.limits, ...limits };
  const changed = Object.keys(next).filter(key => next[key] !== live.profile.limits?.[key]);
  if (!changed.length) no('These are the limits the team already has');
  const productRoot = live.profile.spec?.project?.productRoot;
  if (typeof productRoot !== 'string' || readLease({ productRoot }).status !== 'free') no('A batch holds the lock on the product repository, or its state cannot be read; close the batch first');
  return { instance, profile: live.profile, changed, body: { schemaVersion: 1, stage: 'limits-proposed', from: live.profile.limits, to: next } };
}

export function proposeLimits(options) {
  try { const { body } = planLimits(options); return { ...body, digest: digest(body) }; } catch (error) { return { errors: [{ code: error.code ?? 'LIMITS_REFUSED', field: 'limits', reason: error.message }] }; }
}

export function changeLimits({ confirm, atTerminal, ...options }) {
  try {
    const { instance, profile, changed, body } = planLimits(options);
    if (confirm !== digest(body)) throw new Refusal('LIMITS_NOT_CONFIRMED', 'A change of limits is confirmed by the digest of its proposal; this digest is not the current proposal');
    const path = join(instance, MODE_FILE);
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...profile, limits: body.to }, null, 2) + '\n'); renameSync(`${path}.tmp`, path);
    const at = new Date().toISOString();
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} LIMITS CHANGED: ${changed.map(key => `${key} ${body.from?.[key]} -> ${body.to[key]}`).join(', ')}; proposal ${confirm} was confirmed ${atTerminal === true ? 'by its code, typed at an interactive terminal' : 'by a program that called the change directly, not at a terminal'}.\n`);
    const record = { schemaVersion: 1, stage: 'limits-changed', limits: body.to, changed, changedAt: at };
    return { ...record, digest: digest(record) };
  } catch (error) { return { errors: [{ code: error.code ?? 'LIMITS_REFUSED', field: 'limits', reason: error.message }] }; }
}
