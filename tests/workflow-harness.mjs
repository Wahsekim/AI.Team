// Mock runtime harness for Dynamic Workflow scripts (no Claude API calls).
// Reads the real script, wraps its body in an AsyncFunction, and injects
// mock agent/budget/log/phase globals so the deterministic control flow can
// be tested with injected failures (docs/engine.md "Keeping the engine honest").

import { readFile } from 'node:fs/promises'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Minimal JSON-Schema checker covering the subset the engine's schemas use
// (F-02): the real runtime enforces `opts.schema` on structured returns, so a
// mock that hands back schema-invalid objects would prove nothing. Throws on
// the first violation.
export function validateAgainstSchema(value, schema, path = '$') {
  const fail = msg => { throw new Error(`schema violation at ${path}: ${msg}`) }
  if (schema.enum && !schema.enum.includes(value)) fail(`expected one of ${JSON.stringify(schema.enum)}`)
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('expected object')
      for (const k of schema.required || []) {
        if (!(k in value)) fail(`missing required key '${k}'`)
      }
      for (const [k, v] of Object.entries(value)) {
        const propSchema = (schema.properties || {})[k]
        if (!propSchema) {
          if (schema.additionalProperties === false) fail(`unexpected key '${k}'`)
          continue
        }
        validateAgainstSchema(v, propSchema, `${path}.${k}`)
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) fail('expected array')
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`)
      if (schema.items) value.forEach((v, i) => validateAgainstSchema(v, schema.items, `${path}[${i}]`))
      break
    }
    case 'string': {
      if (typeof value !== 'string') fail('expected string')
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(`shorter than minLength ${schema.minLength}`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`longer than maxLength ${schema.maxLength}`)
      break
    }
    case 'integer': {
      if (!Number.isInteger(value)) fail('expected integer')
      break
    }
    case 'number': {
      if (typeof value !== 'number' || !isFinite(value)) fail('expected finite number')
      break
    }
    case 'boolean': {
      if (typeof value !== 'boolean') fail('expected boolean')
      break
    }
    default: break
  }
  return value
}

// Run a workflow script with mocked globals.
//   scriptPath    - path to the workflow .js file
//   args          - the `args` global the script receives
//   agentImpl     - (prompt, opts, callIndex) => result | Promise (throw/null to inject failures)
//   budgetImpl    - optional { total, spent(), remaining() }
//   enforceSchema - default true: non-null mock returns are validated against
//                   opts.schema and a mismatch THROWS (approximating the real
//                   runtime's enforcement). Set false only to exercise the
//                   engine's own defensive layer beneath schema enforcement.
// Returns { result, calls, logs, phases } where calls records every agent() invocation.
export async function runWorkflow({ scriptPath, args, agentImpl, budgetImpl, enforceSchema = true }) {
  let src = await readFile(scriptPath, 'utf8')
  src = src.replace(/^export const meta =/m, 'const meta =')

  const calls = []
  const logs = []
  const phases = []

  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    const out = await agentImpl(prompt, opts, calls.length)
    if (enforceSchema && out !== null && out !== undefined && opts.schema) {
      validateAgainstSchema(out, opts.schema)
    }
    return out
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

// Standard mock agent set: dispatches on SCHEMA IDENTITY (each engine call kind
// carries a distinct schema — verifier requires 'pass', guardian requires
// 'runawayDetected'), NOT on label substrings: labels embed the untrusted
// ticket text, so a ticket like 'verifier: timeout handling' would mis-route a
// WORKER call to the verifier mock (R5-11). Labels are display-only. Each impl
// may throw or return null to inject faults.
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
    const required = (opts && opts.schema && Array.isArray(opts.schema.required)) ? opts.schema.required : []
    if (required.includes('runawayDetected')) return impl.guardian(prompt, opts, callIndex)
    if (required.includes('pass')) return impl.verifier(prompt, opts, callIndex)
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
