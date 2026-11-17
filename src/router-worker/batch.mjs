import { readFileSync, writeFileSync, appendFileSync, rmSync, lstatSync, mkdirSync, renameSync, copyFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { git, isRepositoryRoot, acquireLease, releaseLease, readLease } from './lease.mjs';
import { freezeRun } from './run-args.mjs';
import { openBoundary, closeBoundary, readBoundary } from './write-boundary.mjs';
import { observeIsolation } from './isolation.mjs';
import { limitsOf } from './switch.mjs';

// ADR 0010, decisions 8 to 12: the one command a PM runs before a batch in a standing Router/Worker team.
// It builds the engine's inputs from the PM's tickets, checks the product repository, computes the ceiling,
// takes the lock and opens the write boundary. A refusal leaves the team and the product as they were.
export const BATCH_FILE = 'rw-batch.json', AFTER_FILE = 'rw-batch-after.json', PROGRESS_FILE = 'rw-batch-commits.json', ARCHIVE = 'batches';
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const oneLine = text => typeof text === 'string' && text.length > 0 && text.length <= 200 && text === text.trim() && !/[\x00-\x1f\x7f]/.test(text);
const MODE_FILE = 'profiles/team-mode.json', JOURNAL = 'holiday/.switch-in-progress.json', LEDGER = 'pm-decisions.md';
const IN_PROGRESS = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
const TICKET_FIELDS = ['id', 'title', 'goal', 'acceptance', 'paths', 'estimate'], TICKET_OPTIONAL = ['expectedPaths', 'commitMessage'], BATCH_FIELDS = ['tickets', 'verificationCommands', 'sensitivePaths', 'nextLifecycleNumber'];
const ESTIMATE = ['execTokens', 'checkTokens', 'reworkTokens'], MAX_PATHS = 100;
const STOP = ['Owner stop', 'Required scope or permission change', 'Missing verification environment'];
// What a standing team accepts by decision: no sandbox is required, and Git-ignored build output is tolerated.
const STANDING = ['BASH_NOT_SANDBOXED', 'IGNORED_PATHS_PRESENT'];
// Never a ticket's to write: Git's own files run code at the PM's next commit, and .claude holds agents and hooks.
const RESERVED = ['.git', '.claude'];

class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const refuse = reason => ({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason }] });
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const ref = (id, value) => ({ id, digest: digest(value) });
// Compared without case: on a case-insensitive file system src/A.js and src/a.js are one file.
export const covers = (grant, other) => { const [g, o] = [grant.toLowerCase(), other.toLowerCase()]; return g.endsWith('/**') ? o === g || o.startsWith(g.slice(0, -2)) : o === g; };
const overlap = (a, b) => covers(a, b) || covers(b, a);
// A sensitive entry written as a bare folder guards everything under it.
const guards = (guarded, path) => overlap(path, guarded) || (!guarded.endsWith('/**') && overlap(path, `${guarded}/**`));
export const plain = text => String(text).replace(/[\x00-\x1f\x7f]/g, '?');
const strings = (value, min = 1) => Array.isArray(value) && value.length >= min && value.every(entry => typeof entry === 'string' && entry);

// The branches a batch never works on: every remote's default, the configured default, and the usual names.
function defaultBranches(product) {
  const remotes = (git(product, 'for-each-ref', '--format=%(symref:short)', 'refs/remotes/*/HEAD') ?? '').split('\n').filter(Boolean).map(name => name.split('/').slice(1).join('/'));
  return [...new Set([...remotes, git(product, 'config', '--get', 'init.defaultBranch')?.trim(), 'main', 'master'].filter(Boolean))];
}
// Every path the work tree holds beyond HEAD, both sides of a rename, exactly as Git names them.
export function changedPaths(product) {
  const status = git(product, 'status', '--porcelain', '-z', '--untracked-files=all');
  need(status !== null, 'The state of the product repository cannot be read');
  const fields = status.split('\0').filter(Boolean), paths = [];
  for (let i = 0; i < fields.length; i++) { paths.push(fields[i].slice(3)); if (/^[RC]/.test(fields[i]) || /^.[RC]/.test(fields[i])) paths.push(fields[++i]); }
  return [...new Set(paths)].sort();
}

// The repository's commit hooks: the folder Git runs them from, with links resolved, the paths inside the
// product a ticket must not write (the folder, and its parent when it is husky's `_` stub folder), and a
// digest of its files. Workers run as the PM's user: this finds a hook that was written or moved during a
// batch; it cannot find a hook that calls a script the worker edited.
export function hooksOf(product) {
  // Git itself says where it runs hooks from: the configured path, or the repository's own folder, also for a linked work tree.
  const configured = git(product, 'config', '--get', 'core.hooksPath')?.trim(), named = git(product, 'rev-parse', '--git-path', 'hooks')?.trim();
  let folder = named ? resolve(product, named) : null;
  try { folder = folder && realpathSync(folder); } catch { /* a folder that does not exist holds no hook */ }
  const inside = path => { const rel = relative(product, path); return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : null; };
  const guarded = folder ? [inside(folder), folder.endsWith(`${sep}_`) ? inside(resolve(folder, '..')) : null, configured && !isAbsolute(configured) ? configured.replace(/\/+$/, '') : null].filter(Boolean) : [];
  let files = [];
  try { files = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() || entry.isSymbolicLink()).map(entry => { try { return [entry.name, bytesDigest(readFileSync(join(folder, entry.name)))]; } catch { return [entry.name, null]; } }).sort(([a], [b]) => a.localeCompare(b)); } catch { /* no folder */ }
  return { configured: configured || null, guarded: [...new Set(guarded.filter(path => !path.startsWith('.git/') && path !== '.git'))], digest: digest({ configured: configured || null, files }) };
}
// The content of each path as it stands: a digest for a file, null for anything else.
export const contentOf = (product, paths) => Object.fromEntries(paths.map(path => {
  const stat = lstatSync(join(product, path), { throwIfNoEntry: false });
  return [path, stat?.isFile() ? bytesDigest(readFileSync(join(product, path))) : null];
}));
// The records of a batch leave the team's root in one move, so a batch is either open or archived.
export function archiveBatch(instance, runId, records, sources) {
  const final = join(instance, ARCHIVE, runId), staging = join(instance, ARCHIVE, `.${runId}.tmp`);
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  for (const [name, record] of Object.entries(records)) writeFileSync(join(staging, name), JSON.stringify(record, null, 2) + '\n');
  for (const [name, file] of Object.entries(sources)) if (exists(join(instance, file))) copyFileSync(join(instance, file), join(staging, name));
  renameSync(staging, final);
  for (const file of Object.values(sources)) rmSync(join(instance, file), { recursive: true, force: true });
}

function checkProduct(product, startAsIs) {
  need(isRepositoryRoot(product), 'The product root is not the top of its own Git repository');
  const head = git(product, 'rev-parse', 'HEAD')?.trim(), branch = git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim();
  need(head, 'The product repository has no commit to start from');
  need(branch, 'The product repository is not on a branch; a batch works on a working branch');
  need(!defaultBranches(product).includes(branch), `The product repository is on its default branch (${branch}); create a working branch first`);
  const gitDir = git(product, 'rev-parse', '--absolute-git-dir')?.trim(), busy = IN_PROGRESS.filter(name => gitDir && exists(join(gitDir, name)));
  need(gitDir && !busy.length, `A Git operation is in progress in the product repository (${busy.join(', ')})`);
  const changed = changedPaths(product);
  need(!changed.length || startAsIs, `The product repository has uncommitted changes (${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}); commit or discard them, or start as is`);
  return { head, branch, preexisting: changed };
}

function checkBatch(batch) {
  need(batch && typeof batch === 'object' && !Array.isArray(batch) && BATCH_FIELDS.every(key => Object.hasOwn(batch, key))
    && Object.keys(batch).every(key => [...BATCH_FIELDS, 'runId', 'date'].includes(key)), `The batch must carry ${BATCH_FIELDS.join(', ')} and optionally runId, date`);
  need(Array.isArray(batch.tickets) && batch.tickets.length >= 1 && batch.tickets.length <= MAX_PATHS, `The batch must list 1 to ${MAX_PATHS} tickets`);
  need(strings(batch.sensitivePaths) && batch.sensitivePaths.length <= MAX_PATHS, `sensitivePaths must list 1 to ${MAX_PATHS} paths no ticket of this batch may write`);
  need(strings(batch.verificationCommands) && batch.verificationCommands.length <= MAX_PATHS, `verificationCommands must list 1 to ${MAX_PATHS} commands`);
  const ids = new Set();
  batch.tickets.forEach((ticket, i) => {
    need(ticket && typeof ticket === 'object' && !Array.isArray(ticket), `Ticket ${i + 1} is not an object`);
    const missing = TICKET_FIELDS.filter(key => ticket[key] === undefined || ticket[key] === null || ticket[key] === '' || (Array.isArray(ticket[key]) && !ticket[key].length));
    need(!missing.length, `Ticket ${ticket.id ?? i + 1} is incomplete: ${missing.join(', ')} missing`);
    need(typeof ticket.id === 'string' && TICKET_ID.test(ticket.id), `Ticket ${i + 1}: the id must be 1 to 40 letters, digits, dots, dashes or underscores`);
    need(!ids.has(ticket.id.toLowerCase()), `Ticket ${ticket.id} appears twice`); ids.add(ticket.id.toLowerCase());
    need(Object.keys(ticket).every(key => [...TICKET_FIELDS, ...TICKET_OPTIONAL].includes(key)), `Ticket ${ticket.id} carries a field the batch does not know`);
    for (const key of ['title', ...(ticket.commitMessage === undefined ? [] : ['commitMessage'])])
      need(oneLine(ticket[key]), `Ticket ${ticket.id}: ${key} must be one line of at most 200 characters, with no space at either end`);
    need(strings(ticket.paths), `Ticket ${ticket.id}: paths must be a list of files or folder grants ("src/x.ts", "src/list/**")`);
    need(ticket.estimate && typeof ticket.estimate === 'object' && Object.keys(ticket.estimate).sort().join() === [...ESTIMATE].sort().join(), `Ticket ${ticket.id}: the estimate must carry exactly ${ESTIMATE.join(', ')}`);
    const reserved = ticket.paths.filter(path => { const parts = path.toLowerCase().split('/'); return RESERVED.includes(parts[0]) || parts.includes('.git'); });
    need(!reserved.length, `Ticket ${ticket.id} claims ${reserved.join(', ')}; no ticket writes under ${RESERVED.join(' or ')}`);
    // Decision 12 bounds the worker by `paths`, so the sensitive paths are judged against `paths`, not against the plan.
    const sensitive = ticket.paths.filter(path => batch.sensitivePaths.some(guarded => guards(guarded, path)));
    need(!sensitive.length, `Ticket ${ticket.id} would be able to write a sensitive path (${sensitive.slice(0, 5).join(', ')}); such a ticket needs a security review, which is not built yet`);
    const files = ticket.paths.filter(path => !path.endsWith('/**'));
    need(ticket.expectedPaths === undefined ? files.length > 0 : strings(ticket.expectedPaths), `Ticket ${ticket.id} grants only folders; add "expectedPaths" with at least one file the worker is expected to touch`);
  });
  // Decision 8: two tickets may not claim the same file, so each can be committed on its own.
  for (let i = 0; i < batch.tickets.length; i++) for (let j = i + 1; j < batch.tickets.length; j++) {
    const a = batch.tickets[i], b = batch.tickets[j], shared = a.paths.filter(path => b.paths.some(other => overlap(path, other)));
    need(!shared.length, `Tickets ${a.id} and ${b.id} claim the same file (${shared.slice(0, 5).join(', ')}); put them in different batches, or make one ticket of them`);
  }
  const all = new Set(batch.tickets.flatMap(ticket => ticket.paths));
  need(all.size <= MAX_PATHS, `The tickets of one batch may claim at most ${MAX_PATHS} paths in all (${all.size} given); use folder grants or a smaller batch`);
}

// The compiler input of one ticket, built from what the PM wrote and what the team's mode profile holds.
function inputOf(ticket, { batch, profile, wrappers, product, limits, allPaths }) {
  const staffing = profile.staffing, tools = staffing.exec.tools, repoId = profile.spec.project.slug;
  const amounts = Object.fromEntries(ESTIMATE.map(key => [key, ticket.estimate[key]]));
  const policy = { schemaVersion: 1, mode: 'router-worker', approvalRef: ref('mode-switch', profile.confirmedProposal ?? profile.specDigest), stackRef: ref('team-spec', profile.spec),
    runtimeRef: ref('count-engine', 'run-n-rounds'), rosterRef: ref('worker-wrappers', wrappers),
    profiles: Object.fromEntries(['exec', 'check', 'guard'].map(duty => [duty, { wrapper: wrappers[duty], permissionRef: ref(`${duty}-staffing`, staffing[duty]) }])),
    allowedWritePaths: allPaths, allowedTools: tools, sensitivePaths: batch.sensitivePaths, verificationCommands: batch.verificationCommands,
    maxBriefChars: 20000, budgetUnit: 'input+cache_creation', maxTicketBudget: limits.authorizationPerTicket };
  return { schemaVersion: 1,
    ticket: { id: ticket.id, title: ticket.title, goal: ticket.goal, acceptance: ticket.acceptance, acceptanceRef: ref('acceptance', ticket.acceptance), isCodeShipping: true, deliveryRequired: false, riskFlags: [] },
    mandate: { ticketId: ticket.id, repoId, approvalRef: ref('batch-ticket', ticket), policyDigest: digest(policy), allowedWritePaths: ticket.paths, allowedTools: tools,
      budgetTokens: limits.authorizationPerTicket, stopConditions: STOP },
    proposal: { assignmentId: `${ticket.id}.exec.1`, checkAssignmentId: `${ticket.id}.check.1`, duty: 'exec', attempt: 1, sessionRef: null, continuationOf: null, methodIds: [],
      selectionReason: 'Planned by the PM from the backlog', expectedPaths: ticket.expectedPaths ?? ticket.paths.filter(path => !path.endsWith('/**')), requestedTools: tools,
      estimate: { ref: ref('pm-estimate', amounts), ...amounts } },
    catalog: { schemaVersion: 1, methods: [] }, policy,
    baseline: { repoId, commit: product.head, candidateRef: ref('product-head', product.head) } };
}

// The team this command works on, or a refusal. Read again once the lock is held, so nothing changes under it.
function liveTeam(teamRoot, instanceRoot) {
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
  need(instance, 'An instance root is required');
  const profile = readJSON(join(instance, MODE_FILE));
  need(profile?.mode === 'router-worker' && profile.status === 'live', 'The team is not live in Router/Worker mode');
  need(profile.dispatch === 'engine', 'This team is not set to run its batches through the count engine');
  need(!exists(join(instance, JOURNAL)), 'A mode switch was interrupted; roll it back first with: team-mode.mjs switch recover --instance <instance-root>');
  const productRoot = profile.spec?.project?.productRoot;
  need(typeof productRoot === 'string', 'The mode profile does not name the product repository');
  let limits;
  try { limits = limitsOf({ limits: profile.limits }); } catch (error) { need(false, `The limits in ${MODE_FILE} are not valid (${error.message}); set them with: team-mode.mjs limits`); }
  need(Object.keys(limits).every(key => Object.hasOwn(profile.limits ?? {}, key)), `${MODE_FILE} does not hold the four limits of this team`);
  return { instance, profile, productRoot, limits };
}

export async function beforeBatch({ teamRoot, instanceRoot, batch, startAsIs = false, manifest }) {
  let lease = null, opened = false, instance, productRoot;
  try {
    ({ instance, productRoot } = liveTeam(teamRoot, instanceRoot));
    need(!exists(join(instance, BATCH_FILE)) && !exists(join(instance, AFTER_FILE)), `A batch is already open (${BATCH_FILE}); close it with after and commit, or abort it, before starting another`);
    checkBatch(batch);
    checkProduct(productRoot, startAsIs === true);
    const held = readLease({ productRoot });
    need(!(held.status === 'held' && held.lease.teamRoot === instance), 'This team holds the lock on the product repository but has no open batch: another "before" or a change of limits is running, or an earlier one died half-way. If nothing is running, clear it with: rw-batch.mjs abort --instance <instance-root>');

    const taken = acquireLease({ teamRoot: instance, productRoot });
    need(!taken.errors, `The lock on the product repository could not be taken: ${taken.errors?.[0]?.reason}`);
    lease = taken.lease.digest;
    // With the lock held, no switch and no change of limits can run: what is read now is what the batch uses.
    const { profile, limits } = liveTeam(teamRoot, instanceRoot), product = checkProduct(productRoot, startAsIs === true), count = batch.tickets.length;
    // Decision 11: paths already changed are kept out of the tickets' commits, so none may lie where a ticket writes.
    const mixed = product.preexisting.filter(path => batch.tickets.some(ticket => ticket.paths.some(grant => covers(grant, path))));
    need(!mixed.length, `These paths are already changed and lie where a ticket of this batch writes (${mixed.slice(0, 5).map(plain).join(', ')}); they could not be kept out of its commit. Commit or discard them first`);
    const closed = readBoundary(instance);
    need(closed && closed.productRoot === productRoot, 'The write-boundary file is missing or was changed. It is rebuilt by a mode switch: team-mode.mjs switch specialist, then switch router-worker');
    need(Object.values(closed.wrappers).every(entry => entry.writePaths.length === 0), 'The write boundary is open: an earlier batch was not closed. Clear it with: rw-batch.mjs abort --instance <instance-root>');
    const hooks = hooksOf(productRoot), hooked = batch.tickets.flatMap(ticket => ticket.paths.filter(path => hooks.guarded.some(guard => overlap(path, guard) || overlap(path, `${guard}/**`))));
    need(!hooked.length, `The repository's commit hooks live in ${hooks.guarded.join(', ')}; no ticket writes there (${hooked.slice(0, 5).join(', ')}): a hook runs as the PM at the next commit`);
    const wrappers = Object.fromEntries(Object.entries(closed.wrappers).map(([name, entry]) => [entry.duty, name]));

    const runId = batch.runId ?? `rw-${product.head.slice(0, 8)}-L${batch.nextLifecycleNumber}`;
    need(typeof runId === 'string' && RUN_ID.test(runId) && !exists(join(instance, ARCHIVE, runId)), `The run id ${plain(runId)} is not a plain identifier, or a batch of that id was already closed; give another "runId"`);
    // Decision 10: the ceiling is computed, never chosen. The engine stops dispatching at 80% of it.
    const ceiling = count * limits.outputAllowancePerTicket + limits.guardianOutputShare, allPaths = [...new Set(batch.tickets.flatMap(ticket => ticket.paths))].sort();
    const run = { rounds: count, date: batch.date ?? new Date().toISOString().slice(0, 10), nextLifecycleNumber: batch.nextLifecycleNumber, runId,
      budgetCeilingTokens: ceiling, estimatedOutputTokens: Math.floor(ceiling / 2), guardianEstimateTokens: limits.authorizationPerTicket, maxAttemptsPerTicket: limits.attemptsPerTicket };
    const inputs = batch.tickets.map(ticket => inputOf(ticket, { batch, profile, wrappers, product, limits, allPaths }));
    let frozen = await freezeRun({ inputs, run, teamRoot: instance });
    need(!frozen.errors, `The batch cannot be frozen: ${frozen.errors?.[0]?.field}: ${frozen.errors?.[0]?.reason}`);
    if (manifest) {
      const chained = await manifest(frozen.args, { teamRoot: instance, productRoot, allowDirty: startAsIs === true });
      need(!chained.errors, chained.errors?.[0]?.reason);
      frozen = await freezeRun({ inputs, run: { ...run, launchManifestDigest: chained.digest }, teamRoot: instance });
      need(!frozen.errors, `The batch cannot be frozen: ${frozen.errors?.[0]?.reason}`);
    }
    const isolation = observeIsolation({ teamRoot: instance, productRoot, lease, dispatch: 'engine', standing: [...STANDING, ...(startAsIs === true ? ['PRODUCT_DIRTY'] : [])] });
    need(!isolation.errors && isolation.status === 'clear', `The team or the product is not in a state to run a batch: ${isolation.errors?.[0]?.reason ?? isolation.findings.filter(f => f.severity !== 'accepted').map(f => `${f.code} (${f.detail})`).join('; ')}`);
    // Nothing may have appeared in the product since it was read: what is there now is what the record says was there.
    const now = checkProduct(productRoot, startAsIs === true);
    need(now.head === product.head && now.branch === product.branch && digest(now.preexisting) === digest(product.preexisting), 'The product repository changed while the batch was being prepared; run the command again');
    need(readLease({ productRoot }).lease?.digest === lease, 'The lock on the product repository was released while the batch was being prepared; run the command again');

    // The write boundary opens last, once nothing can refuse the batch any more but the record itself.
    const boundary = openBoundary({ teamRoot: instance, productRoot, writePaths: allPaths });
    opened = true;
    const at = new Date().toISOString();
    const body = { schemaVersion: 1, stage: 'batch-open', runId: frozen.args.runId, openedAt: at, productRoot, productHead: product.head, branch: product.branch,
      startedAsIs: startAsIs === true, preexisting: product.preexisting, preexistingContent: contentOf(productRoot, product.preexisting), hooks, lease, boundaryDigest: boundary.digest, isolationDigest: isolation.digest,
      limits, ceiling: { outputTokens: ceiling, stopLine: Math.floor(ceiling * 4 / 5) },
      tickets: batch.tickets.map((ticket, i) => ({ id: ticket.id, title: ticket.title, commitMessage: ticket.commitMessage ?? `${ticket.id}: ${ticket.title}`, paths: ticket.paths, expectedPaths: inputs[i].proposal.expectedPaths })),
      sensitivePaths: batch.sensitivePaths, verificationCommands: batch.verificationCommands,
      launchManifest: manifest ? 'chained' : 'absent', runRecord: frozen.record, args: frozen.args };
    const record = { ...body, digest: digest(body) };
    writeFileSync(join(instance, BATCH_FILE), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    // Decision 11: starting on a repository that is not clean is the PM's explicit choice, and it is logged.
    if (record.startedAsIs && product.preexisting.length) {
      try { appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${record.runId} STARTED AS IS: ${product.preexisting.length} path(s) were already changed and are kept out of the tickets' commits (${product.preexisting.slice(0, 10).map(plain).join(', ')}${product.preexisting.length > 10 ? ', ...' : ''}).\n`); }
      catch (error) { rmSync(join(instance, BATCH_FILE), { force: true }); throw error; }
    }
    lease = null; opened = false;
    return record;
  } catch (error) {
    return refuse(error instanceof Refusal || error?.code === 'BOUNDARY_REFUSED' ? error.message : `The batch could not be prepared: ${error?.code ?? error?.message}`);
  } finally {
    if (opened) try { closeBoundary({ teamRoot: instance }); } catch { /* the next before names it and points to abort */ }
    if (lease) releaseLease({ productRoot, lease });
  }
}

// Clears a batch that will not be run, or what a "before" that died left behind: the boundary is closed, this
// team's lock is released and the batch record removed. It checks nothing about the work; that is "after".
export function abortBatch({ teamRoot, instanceRoot }) {
  try {
    let instance;
    try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
    const profile = readJSON(join(instance, MODE_FILE)), productRoot = profile?.spec?.project?.productRoot;
    need(profile?.mode === 'router-worker' && profile.status === 'live' && typeof productRoot === 'string', 'The team is not live in Router/Worker mode');
    need(!exists(join(instance, JOURNAL)), 'A mode switch was interrupted; roll it back first with: team-mode.mjs switch recover --instance <instance-root>');
    const record = readJSON(join(instance, BATCH_FILE)), held = readLease({ productRoot }), boundary = readBoundary(instance);
    const ours = held.status === 'held' && held.lease.teamRoot === instance, open = boundary ? Object.values(boundary.wrappers).some(entry => entry.writePaths.length > 0) : false;
    // A batch that after claimed or closed and commit cannot finish: the boundary is closed and the lock released
    // if after did not get that far, its records are archived, and nothing is committed.
    if (exists(join(instance, AFTER_FILE))) {
      if (open) closeBoundary({ teamRoot: instance });
      if (ours) { const released = releaseLease({ productRoot, lease: held.lease.digest }); need(!released.errors, `The lock could not be released: ${released.errors?.[0]?.reason}`); }
      const id = typeof record?.runId === 'string' && RUN_ID.test(record.runId) && !exists(join(instance, ARCHIVE, record.runId)) ? record.runId : `unreadable-${Date.now()}`;
      // Commits the kit already made for this batch are named: they are on the branch and stay there.
      const made = (readJSON(join(instance, PROGRESS_FILE))?.commits ?? []).filter(commit => typeof commit?.ticket === 'string' && TICKET_ID.test(commit.ticket) && /^[a-f0-9]{40}$/.test(commit?.sha ?? '')).map(commit => `${commit.ticket} ${commit.sha.slice(0, 8)}`);
      const work = made.length ? `${made.length} commit(s) were already made by the kit and stay on the branch (${made.join(', ')}); the rest of what the batch changed is still in the product work tree` : 'Nothing was committed by the kit; what the batch changed is still in the product work tree';
      const stamp = new Date().toISOString(), note = { schemaVersion: 1, stage: 'batch-archived-without-commit', runId: id, archivedAt: stamp, commitsMade: made, boundary: boundary ? 'closed' : 'not-restored', lockReleased: ours,
        next: `${work}: commit it by hand on the working branch, or discard it.${boundary ? '' : ' The write-boundary file is missing or was changed: a mode switch to specialist and back rebuilds it.'}` };
      appendFileSync(join(instance, LEDGER), `${stamp.slice(0, 10)} BATCH ${id} ARCHIVED WITHOUT COMMIT by rw-batch.mjs abort: the batch was not finished by the kit. ${work}.\n`);
      archiveBatch(instance, id, { 'abandoned.json': { ...note, digest: digest(note) } }, { 'batch.json': BATCH_FILE, 'after.json': AFTER_FILE, 'commits.json': PROGRESS_FILE });
      return { ...note, digest: digest(note) };
    }
    need(exists(join(instance, BATCH_FILE)) || ours || open, 'There is no batch to abort');
    if (open) closeBoundary({ teamRoot: instance });
    if (ours) { const released = releaseLease({ productRoot, lease: held.lease.digest }); need(!released.errors, `The lock could not be released: ${released.errors?.[0]?.reason}`); }
    // The record is a file the PM can write; only a well-formed id reaches the ledger.
    const at = new Date().toISOString(), runId = typeof record?.runId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(record.runId) ? record.runId : null;
    // A boundary that is missing or was changed refuses every agent's write. This command cannot rebuild it; a mode switch does.
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${runId ?? '(no readable record)'} ABORTED by rw-batch.mjs abort: ${boundary ? 'the write boundary is closed' : 'the write boundary is missing or was changed and was NOT restored'}${ours ? ', the lock released' : ''}. Nothing about the work was checked.\n`);
    rmSync(join(instance, BATCH_FILE), { recursive: true, force: true });
    const body = { schemaVersion: 1, stage: 'batch-aborted', runId, boundary: boundary ? 'closed' : 'not-restored', lockReleased: ours, abortedAt: at,
      ...(boundary ? {} : { next: 'The write boundary is missing or was changed: every agent write is refused until a mode switch to specialist and back rebuilds it' }) };
    return { ...body, digest: digest(body) };
  } catch (error) {
    return refuse(error instanceof Refusal || error?.code === 'BOUNDARY_REFUSED' ? error.message : `The batch could not be aborted: ${error?.code ?? error?.message}`);
  }
}
