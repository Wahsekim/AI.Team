// Mock runtime harness for Dynamic Workflow scripts (no Claude API calls).
// Reads the real script, wraps its body in an AsyncFunction, and injects
// mock agent/budget/log/phase globals so the deterministic control flow can
// be tested with injected failures (docs/engine.md "Keeping the engine honest").

import { readFile } from 'node:fs/promises'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Run a workflow script with mocked globals.
//   scriptPath  - path to the workflow .js file
//   args        - the `args` global the script receives
//   agentImpl   - (prompt, opts, callIndex) => result | Promise (throw/null to inject failures)
//   budgetImpl  - optional { total, spent(), remaining() }
// Returns { result, calls, logs, phases } where calls records every agent() invocation.
export async function runWorkflow({ scriptPath, args, agentImpl, budgetImpl }) {
  let src = await readFile(scriptPath, 'utf8')
  src = src.replace(/^export const meta =/m, 'const meta =')

  const calls = []
  const logs = []
  const phases = []

  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agentImpl(prompt, opts, calls.length)
  }
  const budget = budgetImpl ?? { total: null, spent: () => 0, remaining: () => Infinity }
  const log = m => logs.push(String(m))
  const phase = t => phases.push(t)
  const banned = name => () => { throw new Error(`${name} is unavailable in workflow scripts`) }

  const fn = new AsyncFunction(
    'args', 'agent', 'budget', 'log', 'phase', 'parallel', 'pipeline', 'workflow',
    src,
  )
  const result = await fn(args, agent, budget, log, phase, banned('parallel-mock'), banned('pipeline-mock'), banned('workflow-mock'))
  return { result, calls, logs, phases }
}

// Standard mock agent set: dispatches on the engine's label conventions
// (worker `iterN:<ticket>:<agentType>`, verifier `iterN:verifier:<ticket>`,
// guardian `chaos:guardian`). Each impl may throw or return null to inject faults.
export function makeAgentImpl({ worker, verifier, guardian } = {}) {
  const defaults = {
    worker: () => ({
      outcome: 'done', progress: true, filesTouched: [], decisionsCount: 0,
      selfReportTokens: 100, blocked: false, terminalStop: false, notes: '',
    }),
    verifier: () => ({
      pass: true, staticPass: true, e2ePass: true, summary: 'all green',
      commandsRun: [{ command: 'npm test', exitCode: 0 }], failures: [],
    }),
    guardian: () => ({
      runawayDetected: false, missedHaltRisk: false, budgetGateCorrect: true,
      droppedFixRetest: false, verdict: 'clean', findings: [], newPatternCandidates: [],
    }),
  }
  const impl = { worker: worker ?? defaults.worker, verifier: verifier ?? defaults.verifier, guardian: guardian ?? defaults.guardian }
  return (prompt, opts, callIndex) => {
    const label = (opts && opts.label) || ''
    if (label === 'chaos:guardian') return impl.guardian(prompt, opts, callIndex)
    if (label.includes(':verifier:')) return impl.verifier(prompt, opts, callIndex)
    return impl.worker(prompt, opts, callIndex)
  }
}

// Mutable-spend budget mock: agent calls bump spend via the returned bump().
export function makeBudget({ total = null, initialSpent = 0 } = {}) {
  let spent = initialSpent
  return {
    total,
    spent: () => spent,
    remaining: () => (total == null ? Infinity : Math.max(0, total - spent)),
    bump: n => { spent += n },
  }
}
