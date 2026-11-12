import { readFileSync, writeFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, bytesDigest, parseJSON } from '../loop/contracts.mjs';
import { stageTeam } from './stage.mjs';
import { ACCEPTABLE_UNKNOWNS } from './isolation.mjs';

// Activation for one disposable smoke run. It stages a fresh copy of the instance,
// requires that copy to be complete, and only then makes the draft wrappers runnable
// in the copy. The instance and its kit are never written.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCOPE = 'disposable-smoke', STATUS = 'activated-disposable-smoke';
const APPROVAL_FIELDS = ['schemaVersion', 'purpose', 'status', 'scope', 'specDigest', 'draftDigest', 'approvedBy', 'acceptedUnknowns'];
const UNRESOLVED = ['live-runtime-evidence', 'independent-sessions', 'runtime-tool-enforcement', 'canary-negatives',
  'disposable-product-clone', 'owner-attended-ceilings', 'session-resume-for-retries'];
const ACTIVE = 'Activated for one owner-approved disposable smoke run';
// Every inactive marker the draft writes, by file class. Each must be found exactly once.
const REWRITES = [
  [/^\.claude\/agents\/[^/]+\.md$/, [
    [/^description: "Inactive Router\/Worker (.+) draft; requires approved activation"$/m, 'description: "Router/Worker $1; disposable smoke activation"'],
    ['Do not run from this draft. Runtime activation is not implemented.', `${ACTIVE}. Work only from a frozen assignment issued by the PM.`]]],
  [/^agents\/worker-(exec|check|guard)\.md$/, [
    ['This is an inactive deployment draft. Do not dispatch until owner mappings and runtime gates pass.', `${ACTIVE}; every admission gate still applies to each call.`]]],
  [/^agents\/router-worker-(contract|router)\.md$/, [['INACTIVE DRAFT. ', `${ACTIVE}. `]]],
  [/^agents\/roster\.md$/, [
    ['INACTIVE: ADR 0008 ratifies topology equivalence, not this deployment; project coverage and runtime evidence remain required.', `${ACTIVE}; this roster is not the project's standing roster.`]]],
];

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, code, reason) => { if (!condition) throw new Refusal(code, reason); };

function readApproval(path, expectedDigest, spec, draft) {
  need(typeof path === 'string' && lstatSync(path, { throwIfNoEntry: false })?.isFile() && lstatSync(path).size <= 64 * 1024, 'APPROVAL_MISSING', 'The owner approval file is missing');
  const bytes = readFileSync(path);
  need(bytesDigest(bytes) === expectedDigest, 'APPROVAL_CHANGED', 'The approval file differs from the digest the caller reviewed');
  let approval;
  try { approval = parseJSON(bytes.toString('utf8')); } catch { approval = null; }
  need(approval && typeof approval === 'object' && Object.keys(approval).sort().join() === [...APPROVAL_FIELDS].sort().join()
    && approval.schemaVersion === 1 && approval.purpose === 'router-worker-activation' && approval.status === 'approved' && approval.scope === SCOPE
    && typeof approval.approvedBy === 'string' && approval.approvedBy.trim()
    && approval.specDigest === digest(spec) && approval.draftDigest === draft.digest
    && Array.isArray(approval.acceptedUnknowns) && new Set(approval.acceptedUnknowns).size === approval.acceptedUnknowns.length
    && approval.acceptedUnknowns.every(code => ACCEPTABLE_UNKNOWNS.includes(code)), 'APPROVAL_INVALID',
  `The approval must approve exactly this spec and draft for scope ${SCOPE}, name its approver, and accept only: ${ACCEPTABLE_UNKNOWNS.join(', ')}`);
  return approval;
}

function rewrite(copy, paths) {
  for (const path of paths) for (const [, edits] of REWRITES.filter(([pattern]) => pattern.test(path))) {
    let text = readFileSync(join(copy, path), 'utf8');
    for (const [from, to] of edits) {
      const found = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, 'gm')) ?? []).length;
      need(found === 1, 'ACTIVATION_REFUSED', `${path}: expected exactly one inactive marker, found ${found}`);
      text = text.replace(from, to);
    }
    writeFileSync(join(copy, path), text);
  }
}

export function activateTeam(input, artifact, activePath, { teamRoot = ROOT, instanceRoot, approvalPath, expectedApprovalDigest } = {}) {
  let staging = null;
  try {
    need(typeof activePath === 'string' && isAbsolute(activePath) && resolve(activePath) === activePath && activePath.endsWith('.rw-active')
      && !lstatSync(activePath, { throwIfNoEntry: false }), 'INVALID_ACTIVATION', 'The destination must be a new absolute path ending in .rw-active');
    const candidate = `${activePath.slice(0, -'.rw-active'.length)}.rw-staging`;
    need(!lstatSync(candidate, { throwIfNoEntry: false }), 'INVALID_ACTIVATION', `${candidate} is in the way`);
    const spec = parseJSON(canonical(input)), draft = parseJSON(canonical(artifact), 16 * 1024 * 1024);
    const approval = readApproval(approvalPath, expectedApprovalDigest, spec, draft);

    const staged = stageTeam(spec, draft, candidate, { teamRoot, instanceRoot });
    if (lstatSync(candidate, { throwIfNoEntry: false })) staging = candidate;
    need(!staged.errors, 'ACTIVATION_REFUSED', `Staging failed: ${staged.errors?.[0].reason}`);
    need(staged.stage === 'staged-structurally-validated', 'ACTIVATION_REFUSED', `The staged copy is ${staged.stage}: ${staged.validator.failures.slice(0, 3).join(' | ')}`);
    need(staged.unstaffed.length === 0, 'ACTIVATION_REFUSED',
      `Enabled workflow duties are unstaffed: ${staged.unstaffed.map(entry => `${entry.workflow}/${entry.role}`).slice(0, 8).join(', ')}`);

    rewrite(candidate, Object.keys(draft.files));
    const activation = { scope: SCOPE, approvalFileDigest: expectedApprovalDigest, specDigest: digest(spec), draftDigest: draft.digest, acceptedUnknowns: approval.acceptedUnknowns };
    const mode = { ...JSON.parse(draft.files['profiles/team-mode.json']), status: STATUS, launchable: true, activation };
    writeFileSync(join(candidate, 'profiles/team-mode.json'), JSON.stringify(mode, null, 2) + '\n');

    const validation = spawnSync('bash', [join(candidate, 'kit/scripts/validate-team.sh'), '--mode', 'deployment', candidate],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C' } });
    const verdict = (validation.stdout ?? '').split('\n').filter(line => line.startsWith('RESULT: ')).pop() ?? '';
    need(validation.status === 0 && verdict.startsWith('RESULT: DEPLOYMENT-STRUCTURALLY-COMPLETE'), 'ACTIVATION_REFUSED', `The activated copy fails the deployment validator: ${verdict}`);

    renameSync(candidate, activePath); staging = null;
    const body = { schemaVersion: 1, stage: STATUS, scope: SCOPE, launchable: true, path: activePath, approvalFileDigest: expectedApprovalDigest,
      approvedBy: approval.approvedBy, specDigest: activation.specDigest, draftDigest: draft.digest, acceptedUnknowns: approval.acceptedUnknowns,
      kit: staged.kit, instanceUnchanged: staged.instanceUnchanged, validator: { verdict: verdict.slice('RESULT: '.length) },
      wrappers: staged.rosterRecord.wrappers, estimatedTokens: staged.context.estimatedTokens, unresolved: UNRESOLVED };
    return { ...body, digest: digest(body) };
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    return { errors: [{ code: error instanceof Refusal ? error.code : 'INVALID_ACTIVATION', field: 'activation', reason: error.message }] };
  }
}
