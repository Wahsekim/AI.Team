// Opt-in, role-scoped brief rendering. Only the maintainer commands access Git.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const pack = join(dirname(script), '../agents/skill-packs');
const lockfile = join(pack, 'lock.json');
const hex = /^[0-9a-f]{40}$/;
const sha = data => createHash('sha256').update(data).digest('hex');
const sources = {
  matt: { repo: 'https://github.com/mattpocock/skills.git', prefix: '', paths: [
    'LICENSE', 'skills/engineering/to-spec/SKILL.md', 'skills/engineering/to-tickets/SKILL.md',
    'skills/engineering/diagnosing-bugs/SKILL.md', 'skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh',
  ] },
  pstack: { repo: 'https://github.com/cursor/plugins.git', prefix: 'pstack/', paths: [
    'LICENSE', 'skills/architect/SKILL.md', 'skills/architect/references/rationale-template.md',
    'skills/architect/references/design-red-flags.md', 'skills/blast-radius/SKILL.md',
  ] },
};
// Explicit PM task classification, not keyword inference from worker-controlled text.
const routes = [
  [['pm'], 'spec', 'matt', 'to-spec'],
  [['pm'], 'tickets', 'matt', 'to-tickets'],
  [['backend', 'frontend'], 'debug', 'matt', 'diagnosing-bugs'],
  [['architect'], 'interface-design', 'pstack', 'architect'],
  [['qa', 'verifier', 'reviewer'], 'impact-review', 'pstack', 'blast-radius'],
];
const locks = () => JSON.parse(readFileSync(lockfile, 'utf8'));
function verify(source, pin) {
  if (!pin || !hex.test(pin.commit) || Object.keys(pin.files).length !== sources[source].paths.length) throw Error('Invalid pin: ' + source);
  for (const path of sources[source].paths) {
    if (sha(readFileSync(join(pack, source, path))) !== pin.files[path]) throw Error('Unverified skill file: ' + source + '/' + path);
  }
}
function section(text, from, until) {
  const start = text.indexOf(from), end = text.indexOf(until, start + from.length);
  if (start < 0 || end < 0) throw Error('Upstream structure changed; review selection: ' + from);
  return text.slice(start, end).trim();
}
function method(name, read) {
  const text = read('SKILL.md');
  switch (name) {
    case 'to-spec': return 'Draft only. Confirm test seams with the owner. Use the agreed context and this template:\n' + section(text, '<spec-template>', '</spec-template>') + '\n</spec-template>';
    case 'to-tickets': return ['Draft only. Ask the owner to confirm slices and blocking edges.', section(text, '### 3. Draft vertical slices', '### 5. Publish'), section(text, '<local-ticket-template>', '</local-ticket-template>') + '\n</local-ticket-template>'].join('\n\n');
    case 'diagnosing-bugs': {
      const start = text.indexOf('# Diagnosing Bugs\n');
      if (start < 0) throw Error('Review changed diagnosing-bugs heading');
      return text.slice(start).replaceAll('scripts/hitl-loop.template.sh', 'agents/skill-packs/matt/skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh');
    }
    case 'architect': {
      const rationale = read('references/rationale-template.md');
      return ['Design only. Use local call sites; sketch the caller before the interface. Return alternatives and rationale to PM.',
        section(rationale, '## Usage', '## Synthesis decision'), section(rationale, '## Tradeoffs accepted', '## Next implementation step'),
        read('references/design-red-flags.md')].join('\n\n');
    }
    case 'blast-radius': return [section(text, "## Don't trust your own writeup", '## Steps'), section(text, '2. Find the one fact', '6. For a big'), section(text, '## What to hand back', 'Write it through')].join('\n\n');
    default: throw Error('Unknown skill');
  }
}
export function brief(role, task) {
  const match = routes.find(([roles, trigger]) => roles.includes(role) && trigger === task);
  if (!match) return ''; // Normal work has zero extra brief content.
  const [, , source, name] = match, pin = locks()[source];
  verify(source, pin);
  const dir = source === 'matt' ? 'skills/engineering/' + name : 'skills/' + name;
  const body = method(name, p => readFileSync(join(pack, source, dir, p), 'utf8'));
  return render(role, task, source, name, pin.commit, body);
}
function render(role, task, source, name, commit, body) {
  return [
    'Selected method: ' + source + '/' + name + '@' + commit + ' (' + role + '/' + task + ').',
    'Method only. Original brief scope, budget, stop rules and team verification gates take precedence. No new permissions.',
    'Do not spawn agents, choose additional models, invoke another skill, install tools, publish issues, push, or deploy from this method. Workers escalate to PM; PM needs separate owner authority for external actions.',
    body,
  ].join('\n\n') + '\n';
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { timeout: 90000, maxBuffer: 2 ** 20, stdio: ['ignore','pipe','inherit'] });
function fetchFiles(name, ref, checkout) {
  const src = sources[name], temp = checkout ? null : mkdtempSync(join(tmpdir(), 'role-skills-'));
  const cwd = checkout ?? temp;
  try {
    if (temp) {
      git(cwd, 'init', '-q', '--bare');
      git(cwd, 'fetch', '-q', '--depth=1', '--no-tags', src.repo, ref);
    } else if (git(cwd, 'remote', 'get-url', 'origin').toString().trim().replace(/\.git$/, '') !== src.repo.replace(/\.git$/, '')) {
      throw Error('Checkout origin does not match the approved source');
    }
    const commit = git(cwd, 'rev-parse', '--verify', (temp ? 'FETCH_HEAD' : ref) + '^{commit}').toString().trim();
    if (!hex.test(commit) || (ref !== 'HEAD' && commit !== ref)) throw Error('Wrong upstream revision');
    const files = {}, hashes = {};
    for (const path of src.paths) {
      const entry = src.prefix + path;
      if (!/^100(644|755) blob /.test(git(cwd, 'ls-tree', commit, '--', entry).toString())) throw Error('Missing or non-regular upstream file: ' + entry);
      files[path] = git(cwd, 'show', commit + ':' + entry);
      hashes[path] = sha(files[path]);
    }
    // Changed headings must be reviewed rather than silently rendering an empty method.
    for (const [, , source, skill] of routes) if (source === name) {
      const base = (name === 'matt' ? 'skills/engineering/' : 'skills/') + skill + '/';
      method(skill, path => files[base + path].toString('utf8'));
    }
    return { files, pin: { commit, files: hashes } };
  } finally { if (temp) rmSync(temp, { recursive: true, force: true }); }
}
function install(name, {files, pin}, state) {
  for (const [path, bytes] of Object.entries(files)) {
    const dest = join(pack, name, path);
    mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes);
  }
  state[name] = pin;
}
const save = state => writeFileSync(lockfile, JSON.stringify(state, null, 2) + '\n');

// Indent all upstream-controlled text as inert Markdown code. Exclude the
// pin-only first line from method diffs; list revision changes separately.
function excerptDiff(before, after) {
  const temp = mkdtempSync(join(tmpdir(), 'role-brief-diff-'));
  try {
    writeFileSync(join(temp, 'before'), before);
    writeFileSync(join(temp, 'after'), after);
    const diff = spawnSync('git', ['diff','--no-index','--no-ext-diff','--no-color','--text','--','before','after'],
      {cwd:temp,encoding:'utf8',maxBuffer:4*1024*1024});
    if (diff.status !== 1) throw Error('Expected a render diff: ' + (diff.error ?? diff.stderr));
    const lines = diff.stdout.slice(diff.stdout.indexOf('@@')).split('\n');
    const preview = lines.slice(0, 60).map(line => '    ' + line.slice(0,160)).join('\n');
    return preview + (lines.length > 60 || lines.some(l => l.length > 160) ? '\n\nPreview truncated; inspect the full pack diff.' : '');
  } finally { rmSync(temp, {recursive:true, force:true}); }
}
function prepare(report) {
  if (existsSync(report)) throw Error('Proposal report path already exists');
  const state = locks(), changes = [];
  const bodyOf = rendered => rendered.slice(rendered.indexOf('\n') + 1);
  for (const source of Object.keys(sources)) {
    verify(source, state[source]);
    const result = fetchFiles(source, 'HEAD');
    const paths = sources[source].paths.filter(p => state[source].files[p] !== result.pin.files[p]);
    if (paths.length) changes.push({source, result, paths});
  }
  if (!changes.length) { console.log('Selected files unchanged; no proposal.'); return; }
  const sections = ['## Pinned skill updates', 'Review before merging. No active brief or deployment has been updated.'];
  for (const {source,result,paths} of changes) {
    const old = state[source].commit, next = result.pin.commit;
    sections.push('### ' + source, '[' + old.slice(0,8) + ' → ' + next.slice(0,8) + '](' + sources[source].repo.replace(/\.git$/, '') + '/compare/' + old + '...' + next + ')',
      'Changed source files: ' + paths.map(p => '`' + p + '`').join(', '));
    for (const [roles, task, src, name] of routes.filter(route => route[2] === source)) {
      const base = (src === 'matt' ? 'skills/engineering/' : 'skills/') + name + '/';
      const content = method(name, path => result.files[base + path].toString('utf8'));
      const role = roles[0], before = bodyOf(brief(role, task));
      const after = bodyOf(render(role, task, src, name, next, content));
      sections.push('**' + roles.join(' / ') + ' · ' + task + '** — ' +
        (before === after ? 'method text unchanged (pin only).' : 'rendered method changed:\n\n' + excerptDiff(before, after)));
    }
  }
  // No writes until both sources and every candidate render have been checked.
  writeFileSync(report, sections.join('\n\n') + '\n', {flag:'wx'});
  for (const {source,result} of changes) install(source,result,state);
  save(state);
}
function main([cmd, ...args]) {
  if (cmd === 'prepare-update' && args.length === 1) { prepare(args[0]); return; }
  if (cmd === 'brief' && args.length === 2) { process.stdout.write(brief(...args)); return; }
  if (cmd === 'verify' && !args.length) {
    const state = locks();
    for (const source of Object.keys(sources)) verify(source, state[source]);
    for (const [[role], task] of routes) brief(role, task);
    console.log('Verified all pinned methods'); return;
  }
  if (cmd === 'check-upstream' && !args.length) {
    const state = locks();
    for (const source of Object.keys(sources)) {
      verify(source, state[source]);
      const { pin } = fetchFiles(source, 'HEAD');
      const changed = sources[source].paths.filter(path => pin.files[path] !== state[source].files[path]);
      console.log(source, pin.commit, changed.length ? 'review changes: ' + changed.join(', ') : 'selected files unchanged');
      if (changed.length) process.exitCode = 1;
    }
    return;
  }
  if (cmd === 'refresh' && [2, 3].includes(args.length) && Object.hasOwn(sources, args[0]) && hex.test(args[1])) {
    const [name, ref, checkout] = args;
    const state = existsSync(lockfile) ? locks() : {};
    if (state[name]) verify(name, state[name]); // Do not clobber locally edited snapshots.
    install(name, fetchFiles(name, ref, checkout), state);
    save(state);
    console.log('Review the vendor and rendered-method diff before committing:', name, ref); return;
  }
  throw Error('Usage: role-skills.mjs brief ROLE TASK | verify | check-upstream | prepare-update NEW_REPORT_PATH | refresh {matt|pstack} FULL_SHA [LOCAL_UPSTREAM_CHECKOUT]');
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
