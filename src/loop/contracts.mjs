import { createHash } from 'node:crypto';
import { validateTaskDisplay } from './display.mjs';

export class LoopError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireThat(condition, code, message) {
  if (!condition) throw new LoopError(code, message);
}
// R04b: a host refusal before any claim or spawn; the driver may treat it as a clean stop.
export function requirePreStart(condition, message) {
  if (!condition) throw Object.assign(new LoopError('INVALID_TRANSITION', message), { preStart: true });
}
const invalid = (condition, message) => requireThat(condition, 'INVALID_SPEC', message);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export function fields(value, keys, label) {
  invalid(value && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
  invalid(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), `${label}: missing or unknown fields`);
}
export function id(value) { invalid(typeof value === 'string' && ID.test(value), `Invalid ID: ${value}`); }
function text(value, label) { invalid(typeof value === 'string' && value.trim().length > 0, `${label}: nonempty string required`); }
function integer(value, min, label) { invalid(Number.isSafeInteger(value) && value >= min, `${label}: integer >= ${min} required`); }
function ids(value, label, nonempty = false) {
  invalid(Array.isArray(value) && (!nonempty || value.length > 0), `${label}: array required`);
  value.forEach(id);
  invalid(new Set(value).size === value.length, `${label}: duplicate IDs`);
}
export function ref(value) { fields(value, ['id', 'digest'], 'Ref'); id(value.id); invalid(DIGEST.test(value.digest), 'Invalid digest'); }
export function relativePath(value) {
  invalid(typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f\x7f:]/.test(value)
    && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe relative path');
  return value;
}
export function pathRef(value) {
  fields(value, ['repoId', 'relativePath'], 'PathRef');
  invalid(['team', 'product'].includes(value.repoId), 'Unknown repoId'); relativePath(value.relativePath);
}

// Version 1 canonical form: sorted object keys, original array order, JSON scalar encoding.
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { invalid(Number.isFinite(value), 'Non-finite JSON number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  invalid(value && Object.getPrototypeOf(value) === Object.prototype, 'Plain JSON object required');
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
export const bytesDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export function specDigest(spec) { const { approvedSpecDigest, ...body } = spec; return digest(body); }

// JSON.parse alone accepts duplicate keys. Check them before parsing the wire document.
export function parseJSON(source, maxBytes = 1024 * 1024) {
  invalid(typeof source === 'string' && Buffer.byteLength(source) <= maxBytes, 'JSON exceeds byte limit');
  let i = 0;
  const ws = () => { while (/\s/.test(source[i] ?? '') && i < source.length) i++; };
  const string = () => {
    const start = i++; let escaped = false;
    while (i < source.length) {
      const c = source[i++];
      if (c === '"' && !escaped) return JSON.parse(source.slice(start, i));
      escaped = c === '\\' && !escaped;
    }
    throw new LoopError('INVALID_SPEC', 'Unterminated JSON string');
  };
  const value = depth => {
    invalid(depth <= 100, 'JSON nesting exceeds 100'); ws();
    if (source[i] === '"') { string(); return; }
    if (source[i] === '{' || source[i] === '[') {
      const object = source[i++] === '{'; const end = object ? '}' : ']'; const seen = new Set(); ws();
      if (source[i] === end) { i++; return; }
      for (;;) {
        if (object) {
          invalid(source[i] === '"', 'Expected JSON key'); const key = string();
          invalid(!seen.has(key), `Duplicate JSON key: ${key}`); seen.add(key); ws();
          invalid(source[i++] === ':', 'Expected colon');
        }
        value(depth + 1); ws();
        if (source[i] === end) { i++; return; }
        invalid(source[i++] === ',', 'Expected comma'); ws();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(i));
    invalid(match, 'Invalid JSON value'); i += match[0].length;
  };
  try { value(0); ws(); invalid(i === source.length, 'Trailing JSON content'); const result = JSON.parse(source); canonical(result); return result; }
  catch (error) { if (error instanceof LoopError) throw error; throw new LoopError('INVALID_SPEC', error.message); }
}

export function validateRunSpec(spec) {
  fields(spec, ['schemaVersion', 'runId', 'goalId', 'supersedesRunId', 'objective', 'mode', 'manifestRef', 'graphVersion', 'initialSnapshotRef', 'criteria', 'tasks', 'limits', 'trustTier', 'approvedSpecDigest'], 'RunSpec');
  invalid(Buffer.byteLength(canonical(spec)) <= 1024 * 1024, 'Spec exceeds 1 MiB');
  invalid([1, 2].includes(spec.schemaVersion), 'Unsupported schema version'); id(spec.runId); id(spec.goalId);
  if (spec.supersedesRunId !== null) { id(spec.supersedesRunId); invalid(spec.supersedesRunId !== spec.runId, 'Run cannot supersede itself'); }
  text(spec.objective, 'objective'); text(spec.graphVersion, 'graphVersion');
  invalid(['goal', 'legacy-count'].includes(spec.mode), 'Invalid mode');
  invalid(['local-attended', 'isolated'].includes(spec.trustTier), 'Invalid trustTier');
  ref(spec.manifestRef); ref(spec.initialSnapshotRef);
  invalid(Array.isArray(spec.criteria) && spec.criteria.length > 0, 'Empty criteria');
  invalid(Array.isArray(spec.tasks) && spec.tasks.length > 0 && spec.tasks.length <= 100, 'Expected 1..100 tasks');
  const criteria = new Map(); const tasks = new Map();
  for (const c of spec.criteria) {
    fields(c, ['id', 'description', 'gateIds', 'humanApprovalRequired'], 'Criterion'); id(c.id); text(c.description, 'description'); ids(c.gateIds, 'gateIds');
    invalid(typeof c.humanApprovalRequired === 'boolean' && (c.gateIds.length || c.humanApprovalRequired), 'Criterion needs gates or human approval');
    invalid(!criteria.has(c.id), 'Duplicate criterion'); criteria.set(c.id, c);
  }
  // Version 2 adds exactly one TaskSpec field: presentation-only `display` (never read by the reducer or scheduler).
  const taskFields = ['id', 'roleId', 'briefRef', 'dependsOn', 'acceptanceIds', 'requiredGateIds', 'scopeId', 'mutatesProduct', 'maxAttempts', 'maxGateRunsPerCandidate', 'priority'];
  if (spec.schemaVersion === 2) taskFields.push('display');
  for (const t of spec.tasks) {
    fields(t, taskFields, 'TaskSpec');
    [t.id, t.roleId, t.scopeId].forEach(id); ref(t.briefRef); ids(t.dependsOn, 'dependsOn'); ids(t.acceptanceIds, 'acceptanceIds', true); ids(t.requiredGateIds, 'requiredGateIds');
    if (spec.schemaVersion === 2) { const problems = validateTaskDisplay(t.display, `TaskSpec ${t.id} display`); invalid(problems.length === 0, problems[0]); }
    invalid(typeof t.mutatesProduct === 'boolean', 'mutatesProduct must be boolean');
    integer(t.maxAttempts, 1, 'maxAttempts'); integer(t.maxGateRunsPerCandidate, 1, 'maxGateRunsPerCandidate'); integer(t.priority, 0, 'priority');
    invalid(!tasks.has(t.id), 'Duplicate task'); tasks.set(t.id, t);
    for (const cId of t.acceptanceIds) {
      requireThat(criteria.has(cId), 'UNKNOWN_REFERENCE', `Unknown criterion ${cId}`);
      invalid(criteria.get(cId).gateIds.every(g => t.requiredGateIds.includes(g)), 'Task omits criterion gates');
    }
  }
  for (const c of criteria.keys()) invalid(spec.tasks.some(t => t.acceptanceIds.includes(c)), `Uncovered criterion ${c}`);
  const visiting = new Set(); const visited = new Set();
  const visit = key => {
    requireThat(tasks.has(key), 'UNKNOWN_REFERENCE', `Unknown dependency ${key}`);
    requireThat(!visiting.has(key), 'GRAPH_CYCLE', `Cycle at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key); tasks.get(key).dependsOn.forEach(visit); visiting.delete(key); visited.add(key);
  };
  tasks.forEach((_, key) => visit(key));
  const l = spec.limits;
  fields(l, ['maxAgentCalls', 'maxWallMs', 'maxTokens', 'maxCostMicroUsd', 'closeoutReserveTokens', 'closeoutReserveMicroUsd', 'quotaStopRemainingPercent', 'quotaSampleMaxAgeMs', 'unknownUsagePolicy'], 'Limits');
  ['maxAgentCalls', 'maxWallMs', 'quotaSampleMaxAgeMs'].forEach(k => integer(l[k], 1, k));
  ['closeoutReserveTokens', 'closeoutReserveMicroUsd'].forEach(k => integer(l[k], 0, k));
  for (const [cap, reserve] of [['maxTokens', 'closeoutReserveTokens'], ['maxCostMicroUsd', 'closeoutReserveMicroUsd']]) {
    if (l[cap] !== null) { integer(l[cap], 1, cap); invalid(l[reserve] < l[cap], 'Reserve must be below cap'); }
  }
  if (l.quotaStopRemainingPercent !== null) { integer(l.quotaStopRemainingPercent, 0, 'quota threshold'); invalid(l.quotaStopRemainingPercent <= 100, 'Invalid quota threshold'); }
  invalid(l.unknownUsagePolicy === 'pause', 'Unknown usage must pause');
  invalid(spec.approvedSpecDigest === specDigest(spec), 'Spec digest mismatch');
  return spec.approvedSpecDigest;
}

export function validateCommand(command) {
  fields(command, ['requestId', 'idempotencyKey', 'runId', 'expectedStateVersion', 'payload'], 'Command');
  [command.requestId, command.idempotencyKey, command.runId].forEach(id);
  integer(command.expectedStateVersion, 0, 'expectedStateVersion'); canonical(command.payload);
}
