import { digest } from '../../../src/loop/contracts.mjs';

const ref = (id, value) => ({ id, digest: digest(value) });

export function inputFixture() {
  const acceptance = ['Failed tag loading shows Retry', 'Retry reissues the request', 'Successful retry renders the list'];
  const amounts = { execTokens: 12000, checkTokens: 6000, reworkTokens: 6000 };
  const policy = {
    schemaVersion: 1, mode: 'router-worker',
    approvalRef: ref('fixture-owner-policy', 'Fixture only: not real owner approval'),
    stackRef: ref('fixture-stack', 'Local tag-list fixture'),
    runtimeRef: ref('fixture-runtime', 'Mock only'),
    rosterRef: ref('fixture-roster', ['sample-worker-exec', 'sample-worker-check', 'sample-worker-guard']),
    profiles: Object.fromEntries(['exec', 'check', 'guard'].map(duty => [duty, {
      wrapper: `sample-worker-${duty}`, permissionRef: ref(`fixture-${duty}-permissions`, { duty, fixture: true }),
    }])),
    allowedWritePaths: ['src/tag-list/**', 'src/api/tags.ts', 'tests/tag-list/**'],
    allowedTools: ['Read', 'Edit', 'Bash'],
    sensitivePaths: ['src/auth/**', 'middleware/**', 'database/policies/**', 'package.json'],
    verificationCommands: ['npm run test:tag-list', 'npm run test:e2e:tag-list'],
    maxBriefChars: 10000, budgetUnit: 'input+cache_creation', maxTicketBudget: 24000,
  };
  return {
    schemaVersion: 1,
    ticket: { id: 'US-08', title: 'Retry failed tag-list loading', goal: 'Recover the list after a failed request',
      acceptance, acceptanceRef: ref('fixture-acceptance-v1', acceptance), isCodeShipping: true,
      deliveryRequired: false, riskFlags: [] },
    mandate: { ticketId: 'US-08', repoId: 'fixture-product', approvalRef: ref('fixture-task-approval', 'Fixture authority only'),
      policyDigest: digest(policy), allowedWritePaths: [...policy.allowedWritePaths], allowedTools: [...policy.allowedTools],
      budgetTokens: 24000, stopConditions: ['Owner stop', 'Required scope or permission change', 'Missing verification environment'] },
    proposal: { assignmentId: 'US-08.exec.1', checkAssignmentId: 'US-08.check.1', duty: 'exec', attempt: 1,
      sessionRef: null, continuationOf: null, methodIds: [],
      selectionReason: 'Cause is known; the project verification recipe is sufficient',
      expectedPaths: ['src/tag-list/view.ts', 'src/api/tags.ts', 'tests/tag-list/retry.test.ts'],
      requestedTools: ['Read', 'Edit', 'Bash'], estimate: { ref: ref('fixture-estimate-v1', amounts), ...amounts } },
    catalog: { schemaVersion: 1, methods: [] }, policy,
    baseline: { repoId: 'fixture-product', commit: '8331e0921b8d8546c1ca3691a3dfa5e709b75971',
      candidateRef: ref('fixture-C1', 'Synthetic candidate; not an inspected checkout') },
  };
}

export const failedCheckReport = {
  schemaVersion: 1, assignmentId: 'US-08.check.1', ticketId: 'US-08', duty: 'check', candidateRef: 'fixture-C1',
  outcome: 'fail', commandsRun: [{ command: 'npm run test:tag-list', exitCode: 1, evidenceRef: 'fixture-artifacts/check-1.log' }],
  unexecutedChecks: ['npm run test:e2e:tag-list'], findings: ['Retry click does not reissue the failed request.'],
  uncertainties: ['Browser acceptance has not been executed.'], blockers: [], deliveryStatus: 'not-accepted',
};
