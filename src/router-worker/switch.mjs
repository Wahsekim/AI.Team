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
// What may be a mode's own file. Anything else named by a profile or a manifest is refused, not moved.
const OWN = {
  specialist: path => path === ROSTER || path === MODE_FILE || inRegistry(path) || (/^agents\/[^/]+\.md$/.test(path) && !SHARED_AGENT_FILES.includes(path)),
  'router-worker': path => path === ROSTER || path === MODE_FILE || inRegistry(path) || /^agents\/(worker-(exec|check|guard)|router-worker-(contract|router))\.md$/.test(path),
};

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
  const cells = line => line.replace(/\{\{[^}]*\}\}/g, 'placeholder').split('|').slice(1, -1).map(cell => cell.trim().replace(/^[`*_]+|[`*_]+$/g, ''));
  const lines = readFileSync(join(instance, ROSTER), 'utf8').split('\n'), roles = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].startsWith('|') ? cells(lines[i]).map(cell => cell.toLowerCase()) : [], id = header.indexOf('role id'), file = header.indexOf('role file');
    if (id < 0 || file < 0) continue;
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) roles.push([cells(lines[j])[id], cells(lines[j])[file]]);
  }
  const delivery = roles.filter(([role, path]) => role && !SHARED_ROLES.includes(role) && safePath(path) && /^agents\/[^/]+\.md$/.test(path) && !SHARED_AGENT_FILES.includes(path) && path !== ROSTER).map(([, path]) => path);
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
  need(!exists(join(instance, HOLIDAY, live.name)), `holiday/${live.name} already exists; a packed team is never overwritten. Move it away by hand if it is not needed`);

  // The live mode's own files, which go on holiday.
  let pack;
  if (live.name === 'specialist') pack = specialistFiles(instance);
  else {
    need(Array.isArray(live.profile.ownFiles), 'The mode profile does not list the files of the Router/Worker team');
    const foreign = live.profile.ownFiles.filter(path => !safePath(path) || !OWN['router-worker'](path));
    need(!foreign.length, `The mode profile lists files that are not Router/Worker files: ${foreign.slice(0, 5).join(', ')}`);
    pack = [...new Set([...live.profile.ownFiles, ...registryFiles(instance)])].filter(path => isFile(join(instance, path))).sort();
  }

  const packed = packedTeam(instance, to), base = { schemaVersion: 1, stage: 'switch-proposed', from: live.name, to, pack };
  // The team is bound to one product repository: the one its Router/Worker spec names.
  const boundSpec = live.profile?.spec ?? (to === 'router-worker' && packed ? readJSON(join(packed.folder, MODE_FILE))?.spec : null) ?? request.spec;
  need(boundSpec?.project?.productRoot === productRoot, 'The product root given is not the product repository this team is bound to');
  checkProduct(productRoot);

  if (packed) {
    need(to === 'specialist' || request.spec === undefined || digest(request.spec) === digest(boundSpec),
      'A packed Router/Worker team exists and comes back as it was packed; to draft another one, move holiday/router-worker away first');
    const install = packed.manifest.files.map(entry => entry.path).sort(), blocked = install.filter(path => exists(join(instance, path)) && !pack.includes(path));
    need(!blocked.length, `These files are in the way of the packed ${to} team: ${blocked.slice(0, 5).join(', ')}`);
    return { kit, instance, live, kind: 'restore', packed, body: { ...base, install, kept: [], restoreManifestDigest: packed.digest } };
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
  const install = Object.keys(draft.files).filter(path => !present.includes(path)).sort();
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
  if (journal.lease && journal.productRoot && readLease({ productRoot: journal.productRoot }).lease?.digest === journal.lease) releaseLease({ productRoot: journal.productRoot, lease: journal.lease });
  rmSync(join(instance, JOURNAL), { force: true }); prune(join(instance, HOLIDAY));
}

export function recoverSwitch({ teamRoot, instanceRoot }) {
  try {
    const instance = instanceOf(resolve(teamRoot), instanceRoot);
    need(instance, 'An instance root is required');
    need(exists(join(instance, JOURNAL)), 'There is no interrupted switch to roll back');
    const journal = readJSON(join(instance, JOURNAL));
    need(journal && MODES.includes(journal.from) && MODES.includes(journal.to) && ['draft', 'restore'].includes(journal.kind) && Array.isArray(journal.pack) && Array.isArray(journal.install)
      && [...journal.pack, ...journal.install].every(safePath), 'The journal of the interrupted switch cannot be read; restore the team by hand from holiday/');
    rollBack(instance, journal);
    const record = { schemaVersion: 1, stage: 'switch-rolled-back', mode: journal.from, abandoned: journal.to };
    return { ...record, digest: digest(record) };
  } catch (error) { return refusal(error); }
}

export function switchMode({ confirm, validate, ...options }) {
  let planned;
  try { planned = plan(options); } catch (error) { return refusal(error); }
  const { instance, kit, live, body, kind, packed, draft, spec, limits } = planned, proposalDigest = digest(body), to = body.to, productRoot = options.productRoot;
  if (confirm !== proposalDigest) return { errors: [{ code: 'SWITCH_NOT_CONFIRMED', field: 'switch', reason: 'The owner confirms a switch by the digest of its proposal; this digest is not the current proposal' }] };

  // The product is locked for the length of the switch, so no batch can start half-way through it.
  const lock = acquireLease({ teamRoot: instance, productRoot });
  if (lock.errors) return refusal(new Refusal('SWITCH_REFUSED', 'The lock on the product repository could not be taken; a batch may have started'));
  const lease = lock.lease.digest, out = join(instance, HOLIDAY, live.name), into = join(instance, HOLIDAY, to);
  const journal = { schemaVersion: 1, from: live.name, to, kind, pack: body.pack, install: body.install, lease, productRoot };
  let verdict = 'restored-as-packed', leftInHoliday = [];
  try {
    mkdirSync(join(instance, HOLIDAY), { recursive: true });
    writeFileSync(join(instance, JOURNAL), JSON.stringify(journal, null, 2) + '\n', { flag: 'wx' });
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
    rmSync(join(instance, JOURNAL));
  } catch (error) {
    try { rollBack(instance, journal); } catch {
      return { errors: [{ code: 'SWITCH_INTERRUPTED', field: 'switch', reason: `The switch failed (${error?.message}) and could not be rolled back; run: team-mode.mjs switch recover --instance <instance-root>` }] };
    }
    return refusal(error);
  }
  releaseLease({ productRoot, lease });
  const at = new Date().toISOString();
  appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} MODE SWITCH: from ${live.name} to ${to}; proposal ${proposalDigest} was confirmed by its digest on the command line (the command cannot tell who ran it). ${body.pack.length} file(s) packed under holiday/${live.name}.\n`);
  const record = { schemaVersion: 1, stage: 'mode-switched', mode: to, from: live.name, proposalDigest, packed: body.pack, installed: body.install, kept: body.kept, leftInHoliday, validator: verdict, switchedAt: at };
  return { ...record, digest: digest(record) };
}
