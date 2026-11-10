import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeAgentImpl, runWorkflow } from '../../../scripts/lib/workflow-harness.mjs';

const scriptPath = fileURLToPath(new URL('../../../.claude/workflows/run-n-rounds.js', import.meta.url));
const allowedAgentTypes = ['sample-worker-exec', 'sample-worker-check', 'sample-worker-guard'];
const [writer, verifier, guardian] = allowedAgentTypes;
const args = {
  rounds: 1, date: '2026-11-05', nextLifecycleNumber: 1, executionMode: 'wrappers',
  budgetCeilingTokens: 10000, allowedAgentTypes, guardianAgentType: guardian,
  plan: [{ ticket: 'US-08', title: 'Tag list retry', isCodeShipping: true,
    agentType: writer, brief: 'Design fixture only', verifierAgentType: verifier }],
};
for (const [name, target, expected] of [
  ['distinct profiles', verifier, [writer, verifier, guardian]],
  ['missing verifier', undefined, []],
  ['same wrapper name: existing validator is not a separation check', writer, [writer, writer, guardian]],
]) {
  const input = structuredClone(args);
  input.plan[0].verifierAgentType = target;
  const { calls, result } = await runWorkflow({ scriptPath, args: input, agentImpl: makeAgentImpl({}) });
  assert.deepEqual(calls.map(c => c.opts.agentType), expected);
  if (!target) assert.equal(result.errorCode, 'invalid-args');
  else assert.equal(result.allPassed, true);
  console.log(name + ': ' + (expected.join(' → ') || 'rejected before dispatch'));
}
