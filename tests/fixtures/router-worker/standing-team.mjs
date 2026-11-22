// A bootstrapped two-root specialist team and a clean product repository, for tests of the standing Router/Worker mode.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { proposeSwitch, switchMode } from '../../../src/router-worker/switch.mjs';
import { bytesDigest } from '../../../src/loop/contracts.mjs';
import { draftSpecFixture } from './draft-spec.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const CLI = fileURLToPath(new URL('../../../scripts/team-mode.mjs', import.meta.url));
export const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
const GOVERNANCE = ['architect', 'coach', 'auditor', 'security'];
const readOnly = { model: 'fixture-governance-model', effort: 'medium', maxTurns: 12, tools: ['Read', 'Grep', 'Glob'] };

// A bootstrapped two-root specialist team with one delivery role (backend) and its wrapper, and a clean product repository.
export function fixture(t, { roles = 'backend' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-switch-'))), root = join(base, 'fixture.team'), kit = join(root, 'kit'), product = join(base, 'product');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(path => path && !/^(tests|docs\/design|\.github)\//.test(path));
  for (const path of tracked) { mkdirSync(dirname(join(kit, path)), { recursive: true }); cpSync(join(ROOT, path), join(kit, path)); }
  mkdirSync(join(product, 'src'), { recursive: true }); writeFileSync(join(product, 'src/app.js'), 'export const x = 1;\n');
  git(product, 'init', '-q');
  // The kit commits with the repository's own identity; a CI runner has none of its own.
  git(product, 'config', 'user.name', 'Fixture PM'); git(product, 'config', 'user.email', 'pm@example.invalid'); git(product, 'add', '-A'); git(product, 'commit', '-q', '-m', 'product');
  const boot = spawnSync('bash', [join(kit, 'scripts/bootstrap-team.sh'), '--project-name', 'Tag List Fixture', '--product-repo', product, ...(roles ? ['--roles', roles] : []), root], { encoding: 'utf8' });
  assert.equal(boot.status, 0, boot.stdout + boot.stderr);
  for (const path of ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'agents/_shared/verify-discipline.md', 'CLAUDE.md'])
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace(/\{\{[^}]*\}\}/g, 'fixture-answer'));
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  if (roles) writeFileSync(join(root, '.claude/agents/tag-list-fixture-backend.md'), '---\nname: "tag-list-fixture-backend"\ndescription: "specialist backend"\nmodel: "m"\n---\n\nRead agents/backend.md.\n');
  const spec = { ...draftSpecFixture(), project: { ...draftSpecFixture().project, productRoot: product },
    governance: Object.fromEntries(GOVERNANCE.map(role => [role, ['architect', 'coach'].includes(role) ? { ...readOnly, tools: [...readOnly.tools, 'Write', 'Edit'] } : readOnly])) };
  const common = { teamRoot: kit, instanceRoot: root, productRoot: product };
  const propose = (to = 'router-worker', request = { spec }) => proposeSwitch({ to, request, ...common });
  const apply = (to = 'router-worker', request = { spec }, confirm, extra = {}) => switchMode({ to, request, ...common, atTerminal: true, ...extra, confirm: confirm ?? propose(to, request).digest });
  const read = path => readFileSync(join(root, path), 'utf8'), digests = paths => Object.fromEntries(paths.map(path => [path, existsSync(join(root, path)) ? bytesDigest(readFileSync(join(root, path))) : null]));
  const tree = () => execFileSync('bash', ['-c', 'cd "$1" && find . -path ./kit -prune -o -type f -exec shasum -a 256 {} + | sort', 'sh', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { base, root, kit, product, spec, common, propose, apply, read, digests, tree, wrappers: () => readdirSync(join(root, '.claude/agents')).sort() };
}
