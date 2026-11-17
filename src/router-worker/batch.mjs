import { readFileSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { git, isRepositoryRoot, acquireLease, releaseLease } from './lease.mjs';
import { freezeRun } from './run-args.mjs';
import { openBoundary, closeBoundary } from './write-boundary.mjs';
import { observeIsolation } from './isolation.mjs';

// ADR 0010, decisions 8 to 12: the one command a PM runs before a batch in a standing Router/Worker team.
// It builds the engine's inputs from the PM's tickets, checks the product repository, computes the ceiling,
// takes the lock and opens the write boundary. A refusal leaves the team and the product as they were.
export const BATCH_FILE = 'rw-batch.json';
const MODE_FILE = 'profiles/team-mode.json', JOURNAL = 'holiday/.switch-in-progress.json', LEDGER = 'pm-decisions.md';
const IN_PROGRESS = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
const TICKET_FIELDS = ['id', 'title', 'goal', 'acceptance', 'paths', 'estimate'], BATCH_FIELDS = ['tickets', 'verificationCommands', 'sensitivePaths', 'nextLifecycleNumber'];
const STOP = ['Owner stop', 'Required scope or permission change', 'Missing verification environment'];
// What a standing team accepts by decision: no sandbox is required, and Git-ignored build output is tolerated.
const STANDING = ['BASH_NOT_SANDBOXED', 'IGNORED_PATHS_PRESENT'];

class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const refuse = reason => ({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason }] });
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const ref = (id, value) => ({ id, digest: digest(value) });
const covers = (grant, other) => grant.endsWith('/**') ? other === grant || other.startsWith(grant.slice(0, -2)) : other === grant;

// The branches a batch never works on: the remote's default, or the usual names when there is no remote.
function defaultBranches(product) {
  const remote = git(product, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.trim().replace(/^origin\//, ''), configured = git(product, 'config', '--get', 'init.defaultBranch')?.trim();
  return [...new Set([remote, configured, 'main', 'master'].filter(Boolean))];
}

function checkProduct(product, startAsIs) {
  need(isRepositoryRoot(product), 'The product root is not the top of its own Git repository');
  const head = git(product, 'rev-parse', 'HEAD')?.trim(), branch = git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim();
  need(head, 'The product repository has no commit to start from');
  need(branch, 'The product repository is not on a branch; a batch works on a working branch');
  need(!defaultBranches(product).includes(branch), `The product repository is on its default branch (${branch}); create a working branch first`);
  const gitDir = git(product, 'rev-parse', '--absolute-git-dir')?.trim(), busy = IN_PROGRESS.filter(name => gitDir && exists(join(gitDir, name)));
  need(gitDir && !busy.length, `A Git operation is in progress in the product repository (${busy.join(', ')})`);
  const status = git(product, 'status', '--porcelain', '--untracked-files=all');
  need(status !== null, 'The state of the product repository cannot be read');
  const changed = status.split('\n').filter(Boolean).map(line => line.slice(3)).sort();
  need(!changed.length || startAsIs, `The product repository has uncommitted changes (${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}); commit or discard them, or start as is`);
  return { head, branch, preexisting: changed };
}

function checkBatch(batch) {
  need(batch && typeof batch === 'object' && !Array.isArray(batch) && BATCH_FIELDS.every(key => Object.hasOwn(batch, key))
    && Object.keys(batch).every(key => [...BATCH_FIELDS, 'runId', 'date'].includes(key)), `The batch must carry ${BATCH_FIELDS.join(', ')} and optionally runId, date`);
  need(Array.isArray(batch.tickets) && batch.tickets.length >= 1 && batch.tickets.length <= 300, 'The batch must list 1 to 300 tickets');
  batch.tickets.forEach((ticket, i) => {
    const missing = TICKET_FIELDS.filter(key => ticket?.[key] === undefined || ticket[key] === null || ticket[key] === '' || (Array.isArray(ticket[key]) && !ticket[key].length));
    need(ticket && typeof ticket === 'object' && !missing.length, `Ticket ${ticket?.id ?? i + 1} is incomplete: ${missing.join(', ')} missing`);
    need(Array.isArray(ticket.paths) && ticket.paths.every(path => typeof path === 'string'), `Ticket ${ticket.id}: paths must be a list of files or folder grants ("src/x.ts", "src/list/**")`);
    need(Object.keys(ticket).every(key => [...TICKET_FIELDS, 'expectedPaths'].includes(key)), `Ticket ${ticket.id} carries a field the batch does not know`);
  });
  // Decision 8: two tickets may not claim the same file, so each can be committed on its own.
  for (let i = 0; i < batch.tickets.length; i++) for (let j = i + 1; j < batch.tickets.length; j++) {
    const a = batch.tickets[i], b = batch.tickets[j], shared = a.paths.filter(path => b.paths.some(other => covers(path, other) || covers(other, path)));
    need(!shared.length, `Tickets ${a.id} and ${b.id} claim the same file (${shared.slice(0, 5).join(', ')}); put them in different batches, or make one ticket of them`);
  }
}

// The compiler input of one ticket, built from what the PM wrote and what the owner confirmed at the switch.
function inputOf(ticket, { batch, profile, wrappers, product, limits, allPaths }) {
  const staffing = profile.staffing, tools = staffing.exec.tools, repoId = profile.spec.project.slug;
  const amounts = Object.fromEntries(['execTokens', 'checkTokens', 'reworkTokens'].map(key => [key, ticket.estimate?.[key]]));
  const policy = { schemaVersion: 1, mode: 'router-worker', approvalRef: ref('mode-switch', profile.confirmedProposal ?? profile.specDigest), stackRef: ref('team-spec', profile.spec),
    runtimeRef: ref('count-engine', 'run-n-rounds'), rosterRef: ref('worker-wrappers', wrappers),
    profiles: Object.fromEntries(['exec', 'check', 'guard'].map(duty => [duty, { wrapper: wrappers[duty], permissionRef: ref(`${duty}-staffing`, staffing[duty]) }])),
    allowedWritePaths: allPaths, allowedTools: tools, sensitivePaths: batch.sensitivePaths, verificationCommands: batch.verificationCommands,
    maxBriefChars: 20000, budgetUnit: 'input+cache_creation', maxTicketBudget: limits.authorizationPerTicket };
  return { schemaVersion: 1,
    ticket: { id: ticket.id, title: ticket.title, goal: ticket.goal, acceptance: ticket.acceptance, acceptanceRef: ref(`${ticket.id}-acceptance`, ticket.acceptance), isCodeShipping: true, deliveryRequired: false, riskFlags: [] },
    mandate: { ticketId: ticket.id, repoId, approvalRef: ref('batch-ticket', ticket), policyDigest: digest(policy), allowedWritePaths: ticket.paths, allowedTools: tools,
      budgetTokens: limits.authorizationPerTicket, stopConditions: STOP },
    proposal: { assignmentId: `${ticket.id}.exec.1`, checkAssignmentId: `${ticket.id}.check.1`, duty: 'exec', attempt: 1, sessionRef: null, continuationOf: null, methodIds: [],
      selectionReason: 'Planned by the PM from the backlog', expectedPaths: ticket.expectedPaths ?? ticket.paths.filter(path => !path.endsWith('/**')), requestedTools: tools,
      estimate: { ref: ref('pm-estimate', amounts), ...amounts } },
    catalog: { schemaVersion: 1, methods: [] }, policy,
    baseline: { repoId, commit: product.head, candidateRef: ref('product-head', product.head) } };
}

export async function beforeBatch({ teamRoot, instanceRoot, batch, startAsIs = false, manifest }) {
  let lease = null, opened = false, instance, productRoot;
  try {
    try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
    need(instance, 'An instance root is required');
    const profile = readJSON(join(instance, MODE_FILE));
    need(profile?.mode === 'router-worker' && profile.status === 'live', 'The team is not live in Router/Worker mode');
    need(profile.dispatch === 'engine', 'This team is not set to run its batches through the count engine');
    need(!exists(join(instance, JOURNAL)), 'A mode switch was interrupted; roll it back first with: team-mode.mjs switch recover --instance <instance-root>');
    need(!exists(join(instance, BATCH_FILE)), `A batch is already open (${BATCH_FILE}); close it before starting another`);
    checkBatch(batch);
    productRoot = profile.spec?.project?.productRoot;
    need(typeof productRoot === 'string', 'The mode profile does not name the product repository');
    const product = checkProduct(productRoot, startAsIs === true), limits = profile.limits, count = batch.tickets.length;

    lease = acquireLease({ teamRoot: instance, productRoot });
    need(!lease.errors, 'The lock on the product repository could not be taken; a batch or a switch may be running');
    const allPaths = [...new Set(batch.tickets.flatMap(ticket => ticket.paths))].sort(), boundary = openBoundary({ teamRoot: instance, productRoot, writePaths: allPaths });
    opened = true;

    // Decision 10: the ceiling is computed, never chosen. The engine stops dispatching at 80% of it.
    const ceiling = count * limits.outputAllowancePerTicket + limits.guardianOutputShare;
    const run = { rounds: count, date: batch.date ?? new Date().toISOString().slice(0, 10), nextLifecycleNumber: batch.nextLifecycleNumber, runId: batch.runId ?? `rw-${product.head.slice(0, 8)}-${count}`,
      budgetCeilingTokens: ceiling, estimatedOutputTokens: Math.floor(ceiling / 2), guardianEstimateTokens: limits.authorizationPerTicket, maxAttemptsPerTicket: limits.attemptsPerTicket };
    const inputs = batch.tickets.map(ticket => inputOf(ticket, { batch, profile, wrappers: boundary.wrappers, product, limits, allPaths }));
    let frozen = await freezeRun({ inputs, run, teamRoot: instance });
    need(!frozen.errors, `The batch cannot be frozen: ${frozen.errors?.[0]?.field}: ${frozen.errors?.[0]?.reason}`);
    if (manifest) {
      const taken = await manifest(frozen.args, { teamRoot: instance, productRoot, allowDirty: startAsIs === true });
      need(!taken.errors, taken.errors?.[0]?.reason);
      frozen = await freezeRun({ inputs, run: { ...run, launchManifestDigest: taken.digest }, teamRoot: instance });
      need(!frozen.errors, `The batch cannot be frozen: ${frozen.errors?.[0]?.reason}`);
    }
    const isolation = observeIsolation({ teamRoot: instance, productRoot, lease: lease.lease.digest, dispatch: 'engine', standing: [...STANDING, ...(startAsIs === true ? ['PRODUCT_DIRTY'] : [])] });
    need(!isolation.errors && isolation.status === 'clear', `The team or the product is not in a state to run a batch: ${isolation.errors?.[0]?.reason ?? isolation.findings.filter(f => f.severity !== 'accepted').map(f => `${f.code} (${f.detail})`).join('; ')}`);

    const at = new Date().toISOString();
    const body = { schemaVersion: 1, stage: 'batch-open', runId: frozen.args.runId, openedAt: at, productRoot, productHead: product.head, branch: product.branch,
      startedAsIs: startAsIs === true, preexisting: product.preexisting, lease: lease.lease.digest, boundaryDigest: boundary.digest, isolationDigest: isolation.digest,
      limits, ceiling: { outputTokens: ceiling, stopLine: Math.floor(ceiling * 4 / 5) }, tickets: batch.tickets.map(ticket => ({ id: ticket.id, paths: ticket.paths })),
      launchManifest: manifest ? 'chained' : 'absent', runRecord: frozen.record, args: frozen.args };
    const record = { ...body, digest: digest(body) };
    // Decision 11: starting on a repository that is not clean is the PM's explicit choice, and it is logged.
    if (record.startedAsIs && product.preexisting.length) appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${record.runId} STARTED AS IS: ${product.preexisting.length} path(s) were already changed and are kept out of the tickets' commits (${product.preexisting.slice(0, 10).join(', ')}${product.preexisting.length > 10 ? ', ...' : ''}).\n`);
    writeFileSync(join(instance, BATCH_FILE), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    lease = null; opened = false;
    return record;
  } catch (error) {
    return refuse(error instanceof Refusal ? error.message : `The batch could not be prepared: ${error?.code ?? error?.message}`);
  } finally {
    if (opened) try { closeBoundary({ teamRoot: instance }); } catch { /* reported by the next before */ }
    if (lease && !lease.errors) releaseLease({ productRoot, lease: lease.lease.digest });
  }
}
