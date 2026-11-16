import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { digest, bytesDigest, parseJSON } from '../loop/contracts.mjs';
import { draftTeam } from './draft.mjs';
import { stageTeam } from './stage.mjs';
import { makeLive } from './activate.mjs';
import { instanceOf } from './roots.mjs';
import { git, isRepositoryRoot, readLease } from './lease.mjs';

// ADR 0010: a deployed team is switched between specialist and Router/Worker mode. The live mode's own
// files (roster, delivery role files, wrappers, mode profile) are packed into holiday/<mode>/ and the
// other mode's are put in place. Shared history is never moved. The owner confirms the proposal's digest.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MODES = ['specialist', 'router-worker'];
const HOLIDAY = 'holiday', MODE_FILE = 'profiles/team-mode.json', ROSTER = 'agents/roster.md', REGISTRY = '.claude/agents', LEDGER = 'pm-decisions.md';
// Roles that belong to the team in either mode; their role files are shared, not packed.
const SHARED_ROLES = ['pm', 'architect', 'coach', 'auditor', 'security', 'chaos'];
export const DEFAULT_LIMITS = { attemptsPerTicket: 1, outputAllowancePerTicket: 15000, guardianOutputShare: 6000, authorizationPerTicket: 200000 };
const LIVE = { active: 'Live: Router/Worker mode of this team, confirmed by the owner at the switch', description: 'standing mode',
  roster: 'the specialist roster is packed under holiday/specialist.' };

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, reason, code = 'SWITCH_REFUSED') => { if (!condition) throw new Refusal(code, reason); };
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

function currentMode(instance) {
  const mode = readJSON(join(instance, MODE_FILE));
  return mode?.mode === 'router-worker' && mode.status === 'live' ? { name: 'router-worker', profile: mode } : { name: 'specialist', profile: null };
}

// The files that are the specialist team's own: its roster, every wrapper, and the role files of its delivery roles.
function specialistFiles(instance) {
  const registry = join(instance, REGISTRY), wrappers = exists(registry) ? readdirSync(registry).filter(name => name.endsWith('.md')).map(name => `${REGISTRY}/${name}`) : [];
  const roles = readFileSync(join(instance, ROSTER), 'utf8').split('\n').map(line => /^\| `?([a-z][a-z0-9-]*)`? \|/.exec(line)?.[1]).filter(Boolean);
  const delivery = [...new Set(roles)].filter(role => !SHARED_ROLES.includes(role)).map(role => `agents/${role}.md`);
  return [ROSTER, ...wrappers, ...delivery, MODE_FILE].filter(path => lstatSync(join(instance, path), { throwIfNoEntry: false })?.isFile()).sort();
}

function checkProduct(instance, productRoot) {
  need(typeof productRoot === 'string' && isRepositoryRoot(productRoot), 'The product root must be the top of its own Git repository');
  const status = git(productRoot, 'status', '--porcelain');
  need(status !== null, 'The state of the product repository cannot be read');
  const changed = status.split('\n').filter(Boolean).map(line => line.slice(3));
  need(!changed.length, `The product repository has uncommitted changes (${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}); commit or discard them before switching`);
  const lease = readLease({ productRoot });
  need(lease.status === 'free', 'A batch holds the lock on the product repository; close it before switching');
}

function limitsOf(request, fallback) {
  const given = request?.limits ?? {};
  need(given && typeof given === 'object' && !Array.isArray(given) && Object.keys(given).every(key => Object.hasOwn(DEFAULT_LIMITS, key))
    && Object.values(given).every(value => Number.isSafeInteger(value) && value >= 1) && (given.attemptsPerTicket ?? 1) <= 3, 'limits may only set the known limits to positive integers');
  return { ...(fallback ?? DEFAULT_LIMITS), ...given };
}

// Everything the switch would do, without doing it.
function plan({ to, request, teamRoot, instanceRoot, productRoot }) {
  need(MODES.includes(to), `The mode must be one of: ${MODES.join(', ')}`);
  const kit = resolve(teamRoot);
  let instance;
  try { instance = instanceOf(kit, instanceRoot); } catch (error) { need(false, `Router/Worker mode needs the two-root layout (${error.message}); migrate the deployment with scripts/migrate-to-instance.sh first`); }
  need(instance, 'An instance root is required');
  const live = currentMode(instance);
  need(live.name !== to, `The team is already in ${to} mode`);
  checkProduct(instance, productRoot);
  const holiday = join(instance, HOLIDAY, to), packedManifest = readJSON(join(holiday, 'manifest.json'));

  if (to === 'specialist') {
    need(packedManifest?.mode === 'specialist' && Array.isArray(packedManifest.files), 'No packed specialist team under holiday/specialist');
    for (const entry of packedManifest.files)
      need(lstatSync(join(holiday, entry.path), { throwIfNoEntry: false })?.isFile() && bytesDigest(readFileSync(join(holiday, entry.path))) === entry.digest,
        `holiday/specialist/${entry.path} is missing or was edited after it was packed`);
    const pack = [...live.profile.ownFiles].filter(path => exists(join(instance, path))).sort();
    const body = { schemaVersion: 1, stage: 'switch-proposed', from: live.name, to, pack, install: packedManifest.files.map(entry => entry.path).sort() };
    return { kit, instance, live, body, packedManifest, spec: null, limits: null, draft: null };
  }

  // The spec confirmed the first time is kept with the packed team; a request may bring another one.
  const spec = request?.spec ?? packedManifest?.spec;
  need(spec && typeof spec === 'object', 'A Router/Worker team spec is required: {"spec": {...}, "limits"?: {...}}');
  need(spec.project?.productRoot === productRoot, 'The spec names another product root than the one given');
  const limits = limitsOf(request, packedManifest?.limits);
  const drafted = draftTeam(spec, { teamRoot: kit, instanceRoot: instance });
  need(!drafted.errors, `The team cannot be drafted: ${drafted.errors?.[0]?.reason}`);
  const draft = drafted.draft;
  // A full copy is staged and validated before the standing team is touched.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rw-switch-')));
  try {
    const staged = stageTeam(spec, draft, join(scratch, 'team.rw-staging'), { teamRoot: kit, instanceRoot: instance });
    need(!staged.errors, `Staging the team failed: ${staged.errors?.[0]?.reason}`);
    need(staged.stage === 'staged-structurally-validated', `The staged team is ${staged.stage}: ${staged.validator.failures.slice(0, 3).join(' | ')}`);
    need(staged.unstaffed.length === 0, `Enabled workflow duties are unstaffed: ${staged.unstaffed.map(entry => `${entry.workflow}/${entry.role}`).slice(0, 8).join(', ')}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const install = Object.keys(draft.files).sort(), pack = specialistFiles(instance);
  const body = { schemaVersion: 1, stage: 'switch-proposed', from: live.name, to, dispatch: 'engine', limits,
    staffing: { ...spec.profiles, ...(spec.governance ?? {}) }, pack, install, specDigest: digest(spec), draftDigest: draft.digest };
  return { kit, instance, live, body, packedManifest, spec, limits, draft };
}

const refusal = error => ({ errors: [{ code: error instanceof Refusal ? error.code : 'SWITCH_REFUSED', field: 'switch', reason: String(error?.message ?? 'The switch could not be prepared') }] });

export function proposeSwitch(options) {
  try { const { body } = plan(options); return { ...body, digest: digest(body) }; } catch (error) { return refusal(error); }
}

export function switchMode({ confirm, ...options }) {
  let planned;
  try { planned = plan(options); } catch (error) { return refusal(error); }
  const { instance, kit, live, body, packedManifest, spec, limits, draft } = planned, proposalDigest = digest(body), to = body.to;
  if (confirm !== proposalDigest) return { errors: [{ code: 'SWITCH_NOT_CONFIRMED', field: 'switch', reason: 'The owner confirms a switch by the digest of its proposal; this digest is not the current proposal' }] };

  const holidayOut = join(instance, HOLIDAY, live.name), holidayIn = join(instance, HOLIDAY, to), moved = [], written = [];
  let verdict = 'restored-as-packed';
  const undo = () => {
    for (const path of written.reverse()) rmSync(join(instance, path), { force: true });
    for (const [from, back] of moved.reverse()) { mkdirSync(dirname(back), { recursive: true }); renameSync(from, back); }
    rmSync(holidayOut, { recursive: true, force: true });
  };
  try {
    need(!exists(holidayOut), `holiday/${live.name} already exists; a packed team is never overwritten`);
    // 1. The live mode's own files go on holiday.
    const manifest = { schemaVersion: 1, mode: live.name, files: [], ...(live.name === 'router-worker' ? { spec: live.profile.spec, limits: live.profile.limits } : {}) };
    for (const path of body.pack) {
      const from = join(instance, path), into = join(holidayOut, path);
      manifest.files.push({ path, digest: bytesDigest(readFileSync(from)) });
      mkdirSync(dirname(into), { recursive: true }); renameSync(from, into); moved.push([into, from]);
    }
    mkdirSync(holidayOut, { recursive: true }); writeFileSync(join(holidayOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // 2. The other mode's files are put in place.
    if (to === 'specialist') {
      for (const entry of packedManifest.files) {
        const into = join(instance, entry.path);
        need(!exists(into), `${entry.path} is in the way of the packed specialist team`);
        mkdirSync(dirname(into), { recursive: true }); renameSync(join(holidayIn, entry.path), into); moved.push([into, join(holidayIn, entry.path)]);
      }
    } else {
      for (const [path, text] of Object.entries(draft.files)) {
        const into = join(instance, path);
        // A governance role file the instance already has stays as the instance wrote it.
        if (exists(into)) continue;
        mkdirSync(dirname(into), { recursive: true }); writeFileSync(into, text); written.push(path);
      }
      makeLive(instance, written, LIVE);
      const mode = { ...parseJSON(draft.files[MODE_FILE]), status: 'live', launchable: true, dispatch: 'engine', limits, staffing: body.staffing, spec,
        specDigest: body.specDigest, draftDigest: draft.digest, confirmedProposal: proposalDigest, ownFiles: [...written].sort() };
      writeFileSync(join(instance, MODE_FILE), JSON.stringify(mode, null, 2) + '\n');
    }

    // 3. The team that results must be a complete deployment. A specialist team comes back byte for byte as it was packed.
    if (to === 'router-worker') {
      const validation = spawnSync('bash', [join(kit, 'scripts/validate-team.sh'), '--mode', 'deployment', instance],
        { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C' } });
      verdict = ((validation.stdout ?? '').split('\n').filter(line => line.startsWith('RESULT: ')).pop() ?? '').slice('RESULT: '.length);
      need(validation.status === 0 && verdict.startsWith('DEPLOYMENT-STRUCTURALLY-COMPLETE'),
        `The switched team fails the deployment validator: ${verdict || 'no verdict'} ${(validation.stdout ?? '').split('\n').filter(line => line.startsWith('FAIL - ')).slice(0, 3).join(' | ')}`);
    }
  } catch (error) {
    undo();
    return refusal(error);
  }
  // The unpacked folder has done its job; what is live is no longer on holiday.
  rmSync(holidayIn, { recursive: true, force: true });
  if (!readdirSync(join(instance, HOLIDAY)).length) rmSync(join(instance, HOLIDAY), { recursive: true, force: true });
  const at = new Date().toISOString();
  appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} OWNER: team mode switched from ${live.name} to ${to} (proposal ${proposalDigest}, confirmed by its digest). ${body.pack.length} file(s) packed under holiday/${live.name}.\n`);
  const record = { schemaVersion: 1, stage: 'mode-switched', mode: to, from: live.name, proposalDigest, packed: body.pack, installed: to === 'specialist' ? body.install : [...written].sort(), validator: verdict, switchedAt: at };
  return { ...record, digest: digest(record) };
}
