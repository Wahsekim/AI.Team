import { readFileSync, realpathSync, lstatSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { digest } from '../loop/contracts.mjs';

// Rollout gate G-02. Observes what a host can check without a live runtime and
// reports the 'runtime-isolation' admission gate. Only 'clear' admits a call.
const DUTIES = ['exec', 'check', 'guard'];
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
const IN_PROGRESS = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
const SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'];
const NOT_OBSERVED = ['independent-sessions', 'runtime-tool-enforcement', 'canary-negatives', 'network-and-external-services',
  'exclusive-ownership-lease'];

function requireValue(condition, message) { if (!condition) throw Error(message); }
const inside = (path, root) => path === root || path.startsWith(root + sep);
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
// Ambient GIT_* variables could redirect discovery to another repository.
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C' });
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: gitEnv() });
  return result.status === 0 && !result.error ? result.stdout : null;
}

function canonicalDirectory(path, label) {
  requireValue(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, `${label} must be a normalized absolute path`);
  requireValue(lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && realpathSync(path) === path, `${label} must be a canonical existing directory`);
  return path;
}

function observeProduct(product, team, add) {
  const top = git(product, 'rev-parse', '--show-toplevel')?.trim();
  if (!top || realpathSync(top) !== product) { add('PRODUCT_NOT_REPOSITORY_ROOT', 'blocked', 'the product root is not the top of its own Git repository'); return null; }
  if (inside(team, product) || inside(product, team)) add('PRODUCT_NOT_SEPARATE', 'blocked', 'the team root and the product root contain one another');
  const head = git(product, 'rev-parse', 'HEAD')?.trim() ?? null;
  if (!head) add('PRODUCT_NO_CANDIDATE', 'blocked', 'the product has no HEAD commit to start from');
  const status = git(product, 'status', '--porcelain', '--ignored');
  if (status === null) { add('PRODUCT_STATE_UNREADABLE', 'unknown', 'git status failed'); return head; }
  const lines = status.split('\n').filter(Boolean), ignored = lines.filter(line => line.startsWith('!!')).length;
  if (lines.length - ignored) add('PRODUCT_DIRTY', 'blocked', `${lines.length - ignored} uncommitted or untracked path(s): existing work is unexplained`);
  if (ignored) add('IGNORED_PATHS_PRESENT', 'unknown', `${ignored} ignored path(s) exist: writes there are invisible to the candidate diff`);
  const gitDir = git(product, 'rev-parse', '--absolute-git-dir')?.trim();
  const busy = gitDir ? IN_PROGRESS.filter(name => exists(join(gitDir, name))) : [];
  if (busy.length) add('PRODUCT_OPERATION_IN_PROGRESS', 'blocked', `Git operation or lock in progress: ${busy.join(', ')}`);
  const worktrees = (git(product, 'worktree', 'list', '--porcelain') ?? '').split('\n').filter(line => line.startsWith('worktree ')).length;
  if (worktrees !== 1) add('PRODUCT_SHARED_METADATA', 'blocked', `${worktrees} work trees share this repository's metadata`);
  const entries = (git(product, 'ls-files', '-s', '-z') ?? '').split('\0').filter(Boolean).map(entry => ({ mode: entry.slice(0, 6), path: entry.split('\t')[1] }));
  const submodules = entries.filter(entry => entry.mode === '160000').length;
  if (submodules) add('SUBMODULE_PRESENT', 'unknown', `${submodules} submodule(s): their content is outside the candidate diff`);
  const external = entries.filter(entry => entry.mode === '120000').filter(entry => {
    const target = resolve(dirname(join(product, entry.path)), readlinkSync(join(product, entry.path)));
    return !inside(target, product);
  }).length;
  if (external) add('EXTERNAL_SYMLINK', 'unknown', `${external} tracked symlink(s) point outside the product root`);
  return head;
}

function frontmatter(text) {
  const lines = text.split('\n'), end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 1) return null;
  const entries = lines.slice(1, end).map(line => /^([A-Za-z]+):\s*(.*)$/.exec(line));
  if (entries.some(match => !match)) return null;
  return Object.fromEntries(entries.map(match => [match[1], match[2].trim().replace(/^"(.*)"$/, '$1')]));
}

function observeWrappers(team, add) {
  const roster = lstatSync(join(team, 'agents/roster.md'), { throwIfNoEntry: false })?.isFile() ? readFileSync(join(team, 'agents/roster.md'), 'utf8') : '';
  const rows = roster.split('\n').filter(line => /^\| worker-/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  const wrappers = {};
  for (const duty of DUTIES) {
    const row = rows.find(cells => cells[0] === `worker-${duty}`), path = row?.[2];
    const file = path && /^\.claude\/agents\/[A-Za-z0-9._-]+\.md$/.test(path) && lstatSync(join(team, path), { throwIfNoEntry: false })?.isFile() ? path : null;
    if (!file) { add('WRAPPER_MISSING', 'blocked', `no registered wrapper file for the ${duty} duty`); continue; }
    const text = readFileSync(join(team, file), 'utf8'), fm = frontmatter(text), name = file.slice('.claude/agents/'.length, -'.md'.length);
    if (!fm || fm.name !== name) { add('WRAPPER_IDENTITY', 'blocked', `${file}: frontmatter is unreadable or its name is not ${name}`); continue; }
    wrappers[duty] = name;
    const tools = (fm.tools ?? '').split(',').map(tool => tool.trim()).filter(Boolean), denied = (fm.disallowedTools ?? '').split(',').map(tool => tool.trim());
    if (!tools.length) add('WRAPPER_INHERITS_ALL_TOOLS', 'blocked', `${file}: no tools line, so every tool is inherited`);
    if (!['Agent', 'Task'].every(tool => denied.includes(tool))) add('DELEGATION_ALLOWED', 'blocked', `${file}: Agent/Task are not denied`);
    if (duty !== 'exec' && (tools.some(tool => WRITE_TOOLS.includes(tool)) || !WRITE_TOOLS.every(tool => denied.includes(tool))))
      add('READ_ONLY_DUTY_CAN_WRITE', 'blocked', `${file}: a ${duty} wrapper lists or fails to deny Write/Edit/NotebookEdit`);
    if (fm.permissionMode !== 'default') add('PERMISSION_MODE', 'blocked', `${file}: permissionMode is not "default"`);
    if (duty !== 'exec' && tools.includes('Bash')) add('BASH_NOT_SANDBOXED', 'unknown', `${file}: Bash can write through the shell; no isolated runner is observed`);
    if (text.includes('Do not run from this draft')) add('WRAPPER_INACTIVE_DRAFT', 'blocked', `${file}: still marked as an inactive draft`);
  }
  if (new Set(Object.values(wrappers)).size !== Object.keys(wrappers).length) add('WRAPPER_IDENTITY', 'blocked', 'two duties share one wrapper');
  return wrappers;
}

// Setting values (paths, hosts, rules) are never copied into the record.
function observeSettings(roots, add) {
  for (const [label, root] of roots) for (const file of SETTINGS) {
    if (!lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()) continue;
    let permissions;
    try { permissions = JSON.parse(readFileSync(join(root, file), 'utf8'))?.permissions ?? {}; }
    catch { add('HOST_SETTINGS_UNREADABLE', 'unknown', `${label} ${file} is not valid JSON`); continue; }
    if (permissions.defaultMode && permissions.defaultMode !== 'default') add('HOST_PERMISSION_BYPASS', 'blocked', `${label} ${file} sets a non-default permission mode`);
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    const broad = allow.filter(rule => typeof rule === 'string' && /^Bash(\(\s*\*?\s*\))?$/.test(rule.trim())).length;
    if (broad) add('BROAD_BASH_ALLOW', 'unknown', `${label} ${file} allows every Bash command (${broad} rule(s))`);
    const extra = Array.isArray(permissions.additionalDirectories) ? permissions.additionalDirectories.length : 0;
    if (extra) add('ADDITIONAL_DIRECTORIES', 'unknown', `${label} ${file} grants ${extra} additional director${extra === 1 ? 'y' : 'ies'}`);
  }
}

export function observeIsolation({ teamRoot, productRoot }) {
  try {
    const team = canonicalDirectory(teamRoot, 'Team root'), product = canonicalDirectory(productRoot, 'Product root');
    const findings = [], add = (code, severity, detail) => findings.push({ code, severity, detail });
    const head = observeProduct(product, team, add), wrappers = observeWrappers(team, add);
    observeSettings([['team', team], ['product', product]], add);
    findings.sort((a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));
    const status = findings.some(f => f.severity === 'blocked') ? 'blocked' : findings.length ? 'unknown' : 'clear';
    const body = { schemaVersion: 1, gate: 'runtime-isolation', status, product: { root: product, head }, teamRoot: team, wrappers,
      findings, notObserved: NOT_OBSERVED };
    return { ...body, digest: digest(body) };
  } catch (error) { return { errors: [{ code: 'INVALID_ISOLATION_OBSERVATION', field: 'isolation', reason: error.message }] }; }
}
