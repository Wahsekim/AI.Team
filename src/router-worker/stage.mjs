import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync, lstatSync, readdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJSON, canonical } from '../loop/contracts.mjs';
import { verifyDraft } from './draft.mjs';
import { loadCoverage } from './coverage.mjs';
import { instanceOf } from './roots.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REGISTRY = '.claude/agents';
// Rebuilt or machine-local state: never part of a staging copy.
const SKIP_NAMES = new Set(['.git', '.venv', 'node_modules', '__pycache__', 'heartbeats', '.team-loop',
  '.playwright-mcp', '.DS_Store', 'settings.local.json']);
const skipName = name => SKIP_NAMES.has(name) || name.startsWith('.env') || name.startsWith('.rw-')
  || name.endsWith('.rw-staging') || name.endsWith('.rw-draft.json') || /\.sqlite(-journal|-wal|-shm)?$/.test(name);

function requireValue(condition, message) { if (!condition) throw Error(message); }
const inside = (path, root) => path === root || path.startsWith(root + sep);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options });
  requireValue(!result.error, `${command} could not run`);
  return result;
}
const git = (dir, ...args) => run('git', ['-C', dir, ...args]);

// Regular files under root as sorted relative paths; skipped entries are reported, not copied.
function listFiles(root, { skipKit }) {
  const files = [], skipped = [];
  const walk = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if ((skipKit && path === 'kit') || (!relative && entry.name === '.git')) continue;
      if (skipName(entry.name) || !(entry.isFile() || entry.isDirectory())) skipped.push(path);
      else if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk('');
  return { files: files.sort(), skipped: skipped.sort() };
}

function treeDigest(root, options) {
  const hash = createHash('sha256'), { files, skipped } = listFiles(root, options);
  for (const path of files) hash.update(`${path}\0`).update(readFileSync(join(root, path))).update('\0');
  return hash.update(skipped.join('\0')).digest('hex');
}

function kitState(kit, lock) {
  const commit = /^kit_commit=(.+)$/m.exec(lock)?.[1];
  if (commit === 'unversioned') return { source: 'copy', commit, state: treeDigest(kit, { skipKit: false }) };
  requireValue(/^[0-9a-f]{40}$/.test(commit ?? ''), 'kit.lock does not record a kit commit');
  const head = git(kit, 'rev-parse', 'HEAD'), status = git(kit, 'status', '--porcelain');
  requireValue(head.status === 0 && head.stdout.trim() === commit, 'kit/ is not at the commit pinned by kit.lock');
  requireValue(status.status === 0 && status.stdout === '', 'kit/ has local changes; staging needs the pinned kit');
  return { source: 'git-clone', commit, state: `${commit}:clean` };
}

function copyTree(from, to, options) {
  const { files, skipped } = listFiles(from, options);
  for (const path of files) {
    mkdirSync(dirname(join(to, path)), { recursive: true });
    copyFileSync(join(from, path), join(to, path));
  }
  return skipped;
}

function stagedRoles(staging) {
  const rows = readFileSync(join(staging, 'agents/roster.md'), 'utf8').split('\n')
    .filter(line => /^\| [a-z]/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  return new Set(rows.filter(row => row[5] === 'active'
    && (row[2] === 'main session' || lstatSync(join(staging, row[2]), { throwIfNoEntry: false })?.isFile())).map(row => row[0]));
}

function destination(stagingPath, instance, kit) {
  requireValue(typeof stagingPath === 'string' && isAbsolute(stagingPath) && resolve(stagingPath) === stagingPath,
    'Staging path must be a normalized absolute path');
  requireValue(basename(stagingPath).endsWith('.rw-staging') && !stagingPath.split(sep).includes('.claude'),
    'Use a new .rw-staging directory outside any runtime registry');
  const parent = dirname(stagingPath);
  requireValue(lstatSync(parent, { throwIfNoEntry: false })?.isDirectory() && realpathSync(parent) === parent, 'Canonical existing staging parent required');
  requireValue(!inside(stagingPath, instance) && !inside(stagingPath, kit), 'Staging must be outside the instance and its kit');
}

export function stageTeam(input, artifact, stagingPath, { teamRoot = ROOT, instanceRoot } = {}) {
  let created = null;
  try {
    const kit = resolve(teamRoot), instance = instanceOf(kit, instanceRoot);
    requireValue(instance, 'Staging requires an existing instance root');
    const options = { teamRoot: kit, instanceRoot: instance }, verified = verifyDraft(input, artifact, options);
    requireValue(!verified.errors, `Draft does not verify against the instance: ${verified.errors?.[0]?.reason}`);
    const draft = parseJSON(canonical(artifact), 4 * 1024 * 1024);
    destination(stagingPath, instance, kit);
    const kitBefore = kitState(kit, readFileSync(join(instance, 'kit.lock'), 'utf8'));
    const instanceBefore = treeDigest(instance, { skipKit: true });

    mkdirSync(stagingPath); created = stagingPath; // fails if the path exists: a staging copy is never overwritten
    const skipped = copyTree(instance, stagingPath, { skipKit: true });
    if (kitBefore.source === 'copy') copyTree(kit, join(stagingPath, 'kit'), { skipKit: false });
    else {
      const clone = run('git', ['clone', '-q', '--no-hardlinks', kit, join(stagingPath, 'kit')]);
      requireValue(clone.status === 0 && git(join(stagingPath, 'kit'), 'checkout', '-q', '--detach', kitBefore.commit).status === 0, 'Cannot clone the pinned kit');
    }
    // The staged registry holds exactly the wrappers of the staged roster.
    const registry = join(stagingPath, REGISTRY), removedWrappers = [];
    for (const name of lstatSync(registry, { throwIfNoEntry: false }) ? readdirSync(registry).sort() : []) {
      if (!name.endsWith('.md') || Object.hasOwn(draft.files, `${REGISTRY}/${name}`)) continue;
      rmSync(join(registry, name)); removedWrappers.push(`${REGISTRY}/${name}`);
    }
    for (const [path, text] of Object.entries(draft.files)) {
      mkdirSync(dirname(join(stagingPath, path)), { recursive: true });
      writeFileSync(join(stagingPath, path), text);
    }

    const validation = run('bash', [join(stagingPath, 'kit/scripts/validate-team.sh'), '--mode', 'deployment', stagingPath],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C' } });
    const lines = validation.stdout.split('\n'), verdict = lines.filter(line => line.startsWith('RESULT: ')).pop();
    requireValue(verdict, 'Deployment validator returned no verdict');
    const passed = validation.status === 0 && verdict.startsWith('RESULT: DEPLOYMENT-STRUCTURALLY-COMPLETE');

    const roles = stagedRoles(stagingPath), duties = loadCoverage(kit, { instanceRoot: instance }).coverage.duties;
    const unstaffed = draft.coverage.rows.filter(row => row.status === 'enabled')
      .flatMap(row => row.duties.filter(duty => !roles.has(duties[duty])).map(duty => ({ workflow: row.id, duty, role: duties[duty] })));

    const kitAfter = kitState(kit, readFileSync(join(instance, 'kit.lock'), 'utf8'));
    requireValue(treeDigest(instance, { skipKit: true }) === instanceBefore && kitAfter.state === kitBefore.state,
      'The instance or its kit changed during staging; discard the staging copy and retry');
    created = null;
    return { stage: passed ? 'staged-structurally-validated' : 'staged-validation-failed', launchable: false, path: stagingPath,
      draftDigest: draft.digest, kit: { source: kitBefore.source, commit: kitBefore.commit }, instanceUnchanged: true,
      validator: { verdict: verdict.slice('RESULT: '.length), failures: lines.filter(line => line.startsWith('FAIL - ')) },
      removedWrappers, skipped, unstaffed, unresolved: draft.unresolved };
  } catch (error) {
    if (created) rmSync(created, { recursive: true, force: true });
    return { errors: [{ code: 'INVALID_TEAM_STAGING', field: 'staging', reason: error.message }] };
  }
}
