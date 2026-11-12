import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync, lstatSync, readdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJSON, canonical, bytesDigest } from '../loop/contracts.mjs';
import { verifyDraft } from './draft.mjs';
import { loadCoverage } from './coverage.mjs';
import { instanceOf } from './roots.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REGISTRY = '.claude/agents';
// Rebuilt or machine-local state: never part of a staging copy.
const SKIP_NAMES = new Set(['.git', '.venv', 'node_modules', '__pycache__', 'heartbeats', '.team-loop',
  '.playwright-mcp', '.DS_Store', 'settings.local.json']);
const skipName = name => SKIP_NAMES.has(name) || name.startsWith('.env') || name.startsWith('.rw-')
  || name.endsWith('.rw-staging') || name.endsWith('.rw-draft.json') || name.endsWith('.bak') || /\.sqlite(-journal|-wal|-shm)?$/.test(name);
// Local profile data may hold hosts, device ids or tokens; only the mode file belongs to the team.
const localProfile = path => /^profiles\/[^/]+\.json$/.test(path) && path !== 'profiles/team-mode.json';

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
      if (skipName(entry.name) || localProfile(path) || !(entry.isFile() || entry.isDirectory())) skipped.push(path);
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

const MENTION = /(?<![A-Za-z0-9_./-])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md)(?![A-Za-z0-9_/-])/g;
const mentions = text => [...new Set([...text.matchAll(MENTION)].map(m => m[1]).filter(path => !path.startsWith('kit/') && !path.includes('..')))].sort();

// The read closure of each staged wrapper: the team files the wrapper names, plus
// the files its own role file names. Paths resolve in the staging copy first,
// then under its kit/. Other files are leaves.
function readClosures(staging, wrappers) {
  const nodes = new Map(), missing = [], estimatedTokens = {};
  const locate = path => [path, `kit/${path}`].find(at => lstatSync(join(staging, at), { throwIfNoEntry: false })?.isFile());
  const add = (path, reads) => {
    const at = locate(path), bytes = readFileSync(join(staging, at));
    nodes.set(path, { path, root: at === path ? 'instance' : 'kit', sha256: bytesDigest(bytes), bytes: bytes.length, reads });
  };
  for (const [wrapper, role] of wrappers) {
    const roleFile = `agents/${role}.md`, closure = new Set([wrapper]);
    const named = mentions(readFileSync(join(staging, wrapper), 'utf8')).filter(path => path !== wrapper);
    for (const path of named) if (!locate(path)) missing.push({ from: wrapper, path });
    const reads = named.filter(locate);
    add(wrapper, reads);
    for (const path of reads) {
      // A role file may name examples; only files that exist are part of the closure.
      const nested = path === roleFile ? mentions(readFileSync(join(staging, locate(path)), 'utf8')).filter(p => p !== path && locate(p)) : [];
      if (!nodes.has(path) || nested.length) add(path, nested);
      closure.add(path);
      for (const leaf of nested) { if (!nodes.has(leaf)) add(leaf, []); closure.add(leaf); }
    }
    estimatedTokens[wrapper] = [...closure].reduce((sum, path) => sum + Math.ceil(nodes.get(path).bytes / 4), 0);
  }
  return { nodes: [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path)).map(({ bytes, ...node }) => node), missing, estimatedTokens };
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

    const wrapperOf = role => `${REGISTRY}/${basename(Object.keys(draft.files).find(path => path.startsWith(`${REGISTRY}/`) && path.endsWith(`-${role}.md`)))}`;
    const workers = ['exec', 'check', 'guard'].map(duty => [duty, wrapperOf(`worker-${duty}`), `worker-${duty}`]);
    const governance = ['architect', 'coach', 'auditor', 'security'].filter(role => roles.has(role)).map(role => [role, wrapperOf(role), role]);
    const closureOf = entries => {
      const { nodes, missing, estimatedTokens } = readClosures(stagingPath, entries.map(([, wrapper, role]) => [wrapper, role]));
      return { context: { metric: 'ceil-utf8-bytes/4', roots: Object.fromEntries(entries.map(([key, wrapper]) => [key, [wrapper]])), nodes, estimatedTokens }, missing };
    };
    const worker = closureOf(workers), governed = closureOf(governance), missingReads = [...worker.missing, ...governed.missing];

    const kitAfter = kitState(kit, readFileSync(join(instance, 'kit.lock'), 'utf8'));
    requireValue(treeDigest(instance, { skipKit: true }) === instanceBefore && kitAfter.state === kitBefore.state,
      'The instance or its kit changed during staging; discard the staging copy and retry');
    created = null;
    return { stage: !passed ? 'staged-validation-failed' : missingReads.length ? 'staged-read-closure-incomplete' : 'staged-structurally-validated',
      launchable: false, path: stagingPath,
      draftDigest: draft.digest, kit: { source: kitBefore.source, commit: kitBefore.commit }, instanceUnchanged: true,
      validator: { verdict: verdict.slice('RESULT: '.length), failures: lines.filter(line => line.startsWith('FAIL - ')) },
      removedWrappers, skipped, unstaffed, context: worker.context, governanceContext: governed.context, missingReads,
      rosterRecord: { wrappers: Object.fromEntries(workers.map(([duty, wrapper]) => [duty, basename(wrapper, '.md')])) },
      unresolved: draft.unresolved };
  } catch (error) {
    if (created) rmSync(created, { recursive: true, force: true });
    return { errors: [{ code: 'INVALID_TEAM_STAGING', field: 'staging', reason: error.message }] };
  }
}
