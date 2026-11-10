import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, parseJSON, digest, bytesDigest } from '../loop/contracts.mjs';
import { loadCoverage, coverageReport } from './coverage.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DUTIES = ['exec', 'check', 'guard'];
const SEEDS = [
  ['charter.template.md', 'charter.md'], ['profiles/project.template.md', 'profiles/project.md'],
  ['profiles/stack.template.md', 'profiles/stack.md'], ['agents/roster.template.md', 'agents/roster.md'],
  ['agents/_shared/verify-discipline.template.md', 'agents/_shared/verify-discipline.md'],
];
const AUTHORITY = ['CLAUDE.md', 'agents/pm.md', 'agents/_shared/meta-rules.md', 'docs/staffing.md',
  'docs/workflow-catalog.md', 'docs/owner-contract.md', 'agents/coach.md', 'agents/auditor.md',
  'agents/security.md', 'agents/chaos.md', 'agents/architect.md', 'agents/lessons.md',
  'decisions/0007-pm-only-commits.md', 'decisions/0008-router-worker-topology.md'];
const LOCAL_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'];

function requireValue(condition, message) { if (!condition) throw Error(message); }
function fields(value, keys) {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'Missing or unknown draft fields');
}
function token(value) { return typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value); }

function validateSpec(spec) {
  fields(spec, ['schemaVersion', 'mode', 'project', 'profiles', 'workflowStates']);
  requireValue(spec.schemaVersion === 1 && spec.mode === 'router-worker', 'This draft entry accepts only explicit router-worker mode; use original bootstrap for specialist');
  fields(spec.project, ['name', 'slug', 'productRoot', 'ui']);
  requireValue(typeof spec.project.name === 'string' && spec.project.name.trim() && spec.project.name.length <= 120
    && !/[\x00-\x1f\x7f`|<>]/.test(spec.project.name), 'Invalid project name');
  requireValue(token(spec.project.slug) && typeof spec.project.ui === 'boolean', 'Invalid project slug or UI flag');
  requireValue(typeof spec.project.productRoot === 'string' && isAbsolute(spec.project.productRoot)
    && resolve(spec.project.productRoot) === spec.project.productRoot && spec.project.productRoot !== '/'
    && !/[\x00-\x1f\x7f]/.test(spec.project.productRoot), 'Product root must be an explicit normalized absolute path');
  fields(spec.profiles, DUTIES);
  for (const duty of DUTIES) {
    const p = spec.profiles[duty]; fields(p, ['model', 'effort', 'maxTurns', 'tools']);
    requireValue(typeof p.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(p.model), 'Invalid roster model identifier');
    requireValue(['low', 'medium', 'high', 'max'].includes(p.effort) && Number.isSafeInteger(p.maxTurns)
      && p.maxTurns >= 1 && p.maxTurns <= 300, 'Invalid effort or turn cap');
    requireValue(Array.isArray(p.tools) && p.tools.length > 0 && p.tools.every(t => LOCAL_TOOLS.includes(t))
      && new Set(p.tools).size === p.tools.length, 'Only explicit local tools are permitted');
    requireValue(duty === 'exec' || !p.tools.some(t => ['Write', 'Edit'].includes(t)), 'Check/guard cannot have direct product-edit tools');
    requireValue(duty !== 'guard' || !p.tools.includes('Bash'), 'This guardian draft supports read-only local inspection only');
  }
}

function readSource(root, path) {
  let full = root;
  for (const part of path.split('/')) {
    full = join(full, part);
    requireValue(!lstatSync(full).isSymbolicLink(), 'Symlink in draft source set');
  }
  const stat = lstatSync(full);
  requireValue(stat.isFile() && stat.size <= 1024 * 1024, 'Draft source must be a bounded regular file');
  return readFileSync(full, 'utf8');
}

function instantiate(spec, source) {
  const temp = mkdtempSync(join(tmpdir(), 'rw-bootstrap-draft-'));
  const pairs = spec.project.ui ? [...SEEDS, ['agents/_shared/browser-access.template.md', 'agents/_shared/browser-access.md']] : SEEDS;
  try {
    const root = join(temp, 'instance'), tool = join(temp, 'tooling/bootstrap-team.sh');
    for (const path of ['CLAUDE.md', ...pairs.map(([seed]) => seed)]) {
      const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source[path]);
    }
    mkdirSync(dirname(tool), { recursive: true }); writeFileSync(tool, source['scripts/bootstrap-team.sh']);
    // The unmodified bootstrap does its real seed instantiation. Its live gates are deliberately absent in this scratch-only copy.
    const result = spawnSync('bash', [tool, '--project-name', spec.project.name, '--product-repo', spec.project.productRoot,
      ...(spec.project.ui ? ['--ui'] : []), root], { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: temp, LC_ALL: 'C' } });
    requireValue(result.status === 0 && !result.error && !result.stdout.includes('RESULT: BOOTSTRAPPED'), 'Draft bootstrap failed or unexpectedly claimed deployment success');
    const verdict = result.stdout.match(/RESULT: (INSTANTIATED-PENDING-INTERVIEW|PENDING-STAFFING|PENDING-RUNTIME-COMPAT)/)?.[1];
    requireValue(verdict, 'Bootstrap did not emit a recognized pending verdict');
    const files = Object.fromEntries(['CLAUDE.md', ...pairs.map(([, target]) => target)].map(path => [path, readFileSync(join(root, path), 'utf8')]));
    return { files, gateStatus: 'not-run-in-draft', verdict };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function workerRole(duty) {
  const job = { exec: 'Complete one bounded, verifiable outcome across layers. Return uncommitted changes and evidence.',
    check: 'Verify the host-bound candidate independently. Run approved checks in an isolated runner; never accept author claims alone.',
    guard: 'Apply the existing agents/chaos.md guardian and halt-investigation obligations; report omissions without changing product state.' }[duty];
  return `# Worker ${duty}\n\n## Base Agent\n\nsynthetic\n\n## Project Overlay\n\n${job}\n\nThis is an inactive deployment draft. Do not dispatch until owner mappings and runtime gates pass.\n\n## Dispatch Contract\n\nRead agents/router-worker-contract.md and the frozen assignment. Preserve charter, M1-M6 and original PM-only commits. No delegation, commits, external-service MCP, new permissions or self-accepted delivery. Missing prerequisites or authority return to PM.\n`;
}

function wrapper(spec, duty) {
  const p = spec.profiles[duty], name = `${spec.project.slug}-worker-${duty}`;
  const denied = ['Agent', 'Task', ...(duty === 'exec' ? [] : ['Write', 'Edit', 'NotebookEdit'])];
  const extra = duty === 'guard' ? '\nRead agents/chaos.md for the original guardian and halt-investigation obligations.\n'
    : spec.project.ui ? '\nRead agents/_shared/browser-access.md for real UI verification. Missing browser/runtime evidence remains unverified; a simulated result does not satisfy M5.\n' : '';
  return `---\nname: "${name}"\ndescription: "Inactive Router/Worker ${duty} draft; requires approved activation"\nmodel: "${p.model}"\neffort: "${p.effort}"\nmaxTurns: ${p.maxTurns}\ntools: ${p.tools.join(', ')}\ndisallowedTools: ${denied.join(', ')}\npermissionMode: "default"\n---\n\n# Specific Agent Contract\n\nDo not run from this draft. Runtime activation is not implemented.\n\nAll read paths below are relative to the team root, where the runtime must start; the product root is separate. Read agents/worker-${duty}.md, agents/router-worker-contract.md, charter.md, profiles/project.md, profiles/stack.md, agents/_shared/meta-rules.md, agents/_shared/verify-discipline.md and the relevant agents/lessons.md index lines.\n${extra}\nModel and effort are copied from agents/roster.md. Bash, when listed, is not a read-only sandbox. Tools do not authorize product, ledger, commit or external-service access beyond the frozen assignment and host boundary.\n`;
}

export function draftTeam(input, { teamRoot = ROOT } = {}) {
  try {
    const spec = parseJSON(canonical(input)); validateSpec(spec);
    const root = resolve(teamRoot); requireValue(realpathSync(root) === root, 'Canonical source root required');
    const loaded = loadCoverage(root), coverage = coverageReport(spec.workflowStates, loaded);
    const paths = [...new Set([...AUTHORITY, 'scripts/bootstrap-team.sh', ...SEEDS.map(([seed]) => seed),
      ...(spec.project.ui ? ['agents/_shared/browser-access.template.md'] : [])])];
    const source = Object.fromEntries(paths.map(path => [path, readSource(root, path)]));
    const base = instantiate(spec, source);
    const files = { ...base.files };
    files['agents/router-worker-contract.md'] = '# Router/Worker common protocol\n\nINACTIVE DRAFT. Retain the original charter and M1-M6; only the PM commits. Skills are methods, never permissions. Exec and check are independent calls; guardian retains the original chaos obligations. Budgets, counters, stops and governance triggers are not reset by topology changes. Runtime isolation, full read closure and owner-ratified responsibility mappings are mandatory before use.\n';
    files['agents/router-worker-router.md'] = '# PM routing supplement\n\nINACTIVE DRAFT. Keep agents/pm.md as the persistent PM protocol. Route by bounded outcome, not FE/BE identity. Compile and preflight frozen assignments; preserve all original lifecycle, retry, verification, count, budget and governance gates. Unknown coverage or owner decisions block activation. This supplement does not authorize direct implementation or change the narrow direct-verify exception.\n';
    const rows = ['# Router/Worker draft roster', '', 'INACTIVE: ADR 0008 ratifies topology equivalence, not this deployment; project coverage and runtime evidence remain required.', '',
      '| Role id | Role file | Wrapper file | Model | Reasoning | Status |', '|---|---|---|---|---|---|',
      '| pm | agents/pm.md | main session | inherits main session | owner-selected | active |'];
    for (const duty of DUTIES) {
      const role = `worker-${duty}`, path = `.claude/agents/${spec.project.slug}-${role}.md`;
      files[`agents/${role}.md`] = workerRole(duty); files[path] = wrapper(spec, duty);
      rows.push(`| ${role} | agents/${role}.md | ${path} | ${spec.profiles[duty].model} | ${spec.profiles[duty].effort} | active |`);
    }
    for (const role of ['architect', 'coach', 'auditor', 'security']) rows.push(`| ${role} | agents/${role}.md | — (pending governance staffing) | owner-selected | owner-selected | dormant |`);
    files['agents/roster.md'] = rows.join('\n') + '\n';
    const mode = { schemaVersion: 1, mode: 'router-worker', status: 'draft', launchable: false,
      topologyOnly: true, executionMode: 'wrappers', maxConcurrentExec: 1, coverageDigest: digest(coverage) };
    files['profiles/team-mode.json'] = JSON.stringify(mode, null, 2) + '\n';
    const body = { schemaVersion: 1, kind: 'inert-overlay-draft', launchable: false, inputDigest: digest(spec),
      requiresFreshBaseKit: true, bootstrap: { sourceDigest: bytesDigest(source['scripts/bootstrap-team.sh']), verdict: base.verdict, gateStatus: base.gateStatus },
      sourceFiles: paths.sort().map(path => ({ path, sha256: bytesDigest(source[path]) })),
      coverage, files, unresolved: ['deployment-responsibility-coverage', 'enabled-governance-staffing', 'retry-state-enforcement',
        'profile-interview', 'generated-source-adapters', 'complete-context-closure', 'runtime-and-deployment-validation', 'live-activation'] };
    requireValue(paths.every(path => bytesDigest(readSource(root, path)) === bytesDigest(source[path]))
      && canonical(loadCoverage(root)) === canonical(loaded), 'Draft sources changed during generation; retry from a reviewed snapshot');
    return { draft: { ...body, digest: digest(body) } };
  } catch (error) { return { errors: [{ code: 'INVALID_TEAM_DRAFT', field: 'draft', reason: error.message }] }; }
}

export function writeDraft(draft, outputPath) {
  const { digest: expected, ...body } = draft;
  requireValue(draft.kind === 'inert-overlay-draft' && draft.launchable === false && expected === digest(body), 'Only a consistent inert draft may be written');
  const destination = resolve(outputPath), parent = dirname(destination);
  requireValue(basename(destination).endsWith('.rw-draft.json') && !destination.split(sep).includes('.claude'), 'Use a .rw-draft.json artifact outside any runtime registry');
  requireValue(realpathSync(parent) === parent, 'Canonical existing output parent required');
  const temp = mkdtempSync(join(parent, '.rw-draft-'));
  try {
    const file = join(temp, 'payload.json');
    writeFileSync(file, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    linkSync(file, destination);
    return { path: destination, digest: expected, launchable: false };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function inspectWrapper(text, spec, duty) {
  const lines = text.split('\n'), end = lines.indexOf('---', 1);
  requireValue(lines[0] === '---' && end > 1, 'Wrapper frontmatter is missing');
  const entries = lines.slice(1, end).map(line => {
    const match = /^([A-Za-z]+): (.+)$/.exec(line);
    requireValue(match, 'Unrecognized wrapper frontmatter'); return [match[1], match[2]];
  });
  requireValue(new Set(entries.map(([key]) => key)).size === entries.length, 'Duplicate frontmatter keys');
  const fm = Object.fromEntries(entries), p = spec.profiles[duty];
  fields(fm, ['name', 'description', 'model', 'effort', 'maxTurns', 'tools', 'disallowedTools', 'permissionMode']);
  requireValue(JSON.parse(fm.name) === `${spec.project.slug}-worker-${duty}` && JSON.parse(fm.model) === p.model
    && JSON.parse(fm.effort) === p.effort && fm.maxTurns === String(p.maxTurns)
    && JSON.parse(fm.permissionMode) === 'default', 'Wrapper identity/model/permission mismatch');
  requireValue(canonical(fm.tools.split(', ')) === canonical(p.tools), 'Wrapper tool set differs from the spec');
  const denied = fm.disallowedTools.split(', ');
  requireValue(['Agent', 'Task'].every(tool => denied.includes(tool)), 'Wrapper permits delegation');
  requireValue(duty === 'exec' || ['Write', 'Edit', 'NotebookEdit'].every(tool => denied.includes(tool)), 'Read-only duty is missing write denials');
  requireValue(text.includes(`agents/worker-${duty}.md`) && text.includes('agents/router-worker-contract.md')
    && text.includes('Do not run from this draft.'), 'Wrapper is missing its role/contract or inactive status');
  requireValue(text.includes('relative to the team root') && text.includes('agents/lessons.md'), 'Wrapper read root or lessons source is missing');
  if (duty === 'guard') requireValue(text.includes('agents/chaos.md'), 'Guardian source is missing');
  else if (spec.project.ui) requireValue(text.includes('agents/_shared/browser-access.md'), 'UI verification source is missing');
}

function inspectRoster(text, spec) {
  const rows = text.split('\n').filter(line => /^\| [a-z]/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  const ids = rows.map(row => row[0]);
  requireValue(canonical([...ids].sort()) === canonical(['pm', ...DUTIES.map(d => `worker-${d}`), 'architect', 'coach', 'auditor', 'security'].sort()),
    'Roster omitted or duplicated a required duty/governance role');
  for (const duty of DUTIES) {
    const row = rows.find(row => row[0] === `worker-${duty}`);
    requireValue(row.length === 6 && row[1] === `agents/worker-${duty}.md`
      && row[2] === `.claude/agents/${spec.project.slug}-worker-${duty}.md`
      && row[3] === spec.profiles[duty].model && row[4] === spec.profiles[duty].effort && row[5] === 'active', 'Roster-to-wrapper binding mismatch');
  }
  requireValue(rows.find(row => row[0] === 'pm')[2] === 'main session', 'Router must remain the PM main session');
}

export function verifyDraft(input, artifact, options = {}) {
  try {
    const spec = parseJSON(canonical(input)); validateSpec(spec);
    const draft = parseJSON(canonical(artifact), 4 * 1024 * 1024);
    fields(draft, ['schemaVersion', 'kind', 'launchable', 'inputDigest', 'requiresFreshBaseKit', 'bootstrap',
      'sourceFiles', 'coverage', 'files', 'unresolved', 'digest']);
    const { digest: expected, ...body } = draft;
    requireValue(draft.schemaVersion === 1 && draft.kind === 'inert-overlay-draft' && draft.launchable === false
      && draft.requiresFreshBaseKit === true && draft.inputDigest === digest(spec) && expected === digest(body), 'Draft identity/digest mismatch');
    requireValue(draft.bootstrap.gateStatus === 'not-run-in-draft' && draft.coverage.activationAllowed === false,
      'Draft cannot claim completed deployment gates');
    for (const duty of DUTIES) inspectWrapper(draft.files[`.claude/agents/${spec.project.slug}-worker-${duty}.md`], spec, duty);
    inspectRoster(draft.files['agents/roster.md'], spec);
    const mode = parseJSON(draft.files['profiles/team-mode.json']);
    requireValue(mode.mode === 'router-worker' && mode.launchable === false && mode.status === 'draft'
      && mode.maxConcurrentExec === 1 && mode.coverageDigest === digest(draft.coverage), 'Team mode metadata is inconsistent');
    const regenerated = draftTeam(spec, options);
    requireValue(!regenerated.errors && canonical(regenerated.draft) === canonical(draft), 'Draft differs from current source inputs; regenerate and review');
    return { stage: 'draft-consistency-checked', launchable: false, artifactDigest: expected, inputDigest: draft.inputDigest,
      checks: ['identity-and-digest', 'roster-wrapper-binding', 'local-tool-denials', 'inactive-mode', 'current-source-regeneration'],
      unresolved: draft.unresolved };
  } catch (error) { return { errors: [{ code: 'INVALID_TEAM_DRAFT', field: 'draft', reason: error.message }] }; }
}
