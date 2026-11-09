import { openSync, closeSync, readFileSync, fstatSync, lstatSync, realpathSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { canonical, digest, bytesDigest, parseJSON } from '../loop/contracts.mjs';
import { compile } from './compile.mjs';
import { loadMethods, MethodError } from './methods.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const DUTIES = ['exec', 'check', 'guard'];
const REF_FIELDS = ['policy.approvalRef', 'policy.stackRef', 'policy.runtimeRef', 'policy.rosterRef',
  ...DUTIES.map(d => `policy.profiles.${d}.permissionRef`), 'mandate.approvalRef'];

class PreflightError extends Error {
  constructor(code, field, reason) { super(reason); this.finding = { code, field, reason }; }
}

function requireValue(condition, field, reason, code = 'INVALID_PREFLIGHT') {
  if (!condition) throw new PreflightError(code, field, reason);
}

function fields(value, keys, field) {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
    && keys.every(k => Object.hasOwn(value, k)), field, 'Missing or unknown fields');
}

function relative(value) {
  requireValue(typeof value === 'string' && value.length <= 512 && !/[\\:\x00-\x1f\x7f*?\[\]{}]/.test(value)
    && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..' && p === p.trim()),
  'path', 'Expected a literal normalized relative path');
  return value;
}

function readFile(root, path) {
  let full = root;
  for (const part of relative(path).split('/')) {
    full = join(full, part);
    requireValue(!lstatSync(full).isSymbolicLink(), path, 'Symlink in frozen read set', 'UNSAFE_SOURCE_PATH');
  }
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    requireValue(stat.isFile() && stat.size <= 1024 * 1024, path, 'Expected a regular file of at most 1 MiB');
    const bytes = readFileSync(fd);
    requireValue(bytes.length <= 1024 * 1024, path, 'File exceeds 1 MiB');
    return bytes;
  } finally { closeSync(fd); }
}

function stringList(value, field, min = 0) {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= 256
    && value.every(v => typeof v === 'string') && new Set(value).size === value.length, field, 'Invalid or duplicate list entries');
}

function verifySources(input, approval, read) {
  requireValue(Array.isArray(approval.sources) && approval.sources.length === REF_FIELDS.length, 'sources', 'Every required source reference must be resolved');
  const seen = new Set();
  for (const source of approval.sources) {
    fields(source, ['field', 'path'], 'source');
    requireValue(REF_FIELDS.includes(source.field) && !seen.has(source.field), 'source.field', 'Unknown or duplicate source field');
    seen.add(source.field);
    const expected = source.field.split('.').reduce((value, key) => value[key], input);
    const record = parseJSON(read(source.path).toString('utf8'));
    fields(record, ['id', 'value'], source.path);
    requireValue(record.id === expected.id && digest(record.value) === expected.digest,
      source.field, 'Referenced source identity or content changed', 'SOURCE_MISMATCH');
    if (source.field === 'policy.stackRef') requireValue(canonical(record.value.verificationCommands) === canonical(input.policy.verificationCommands),
      source.field, 'Verification commands differ from the referenced stack', 'SOURCE_MISMATCH');
    if (source.field === 'policy.rosterRef') requireValue(canonical(record.value.wrappers)
      === canonical(Object.fromEntries(DUTIES.map(d => [d, input.policy.profiles[d].wrapper]))),
    source.field, 'Wrapper names differ from the referenced roster', 'SOURCE_MISMATCH');
  }
}

function measureContext(input, preview, graph, read) {
  fields(graph, ['metric', 'roots', 'limits', 'nodes'], 'context');
  requireValue(graph.metric === 'ceil-utf8-bytes/4', 'context.metric', 'Unsupported context estimate metric');
  fields(graph.roots, DUTIES, 'context.roots'); fields(graph.limits, DUTIES, 'context.limits');
  requireValue(Array.isArray(graph.nodes) && graph.nodes.length > 0 && graph.nodes.length <= 256, 'context.nodes', 'Expected 1..256 context nodes');
  const nodes = new Map();
  for (const node of graph.nodes) {
    fields(node, ['path', 'sha256', 'reads'], 'context.node'); relative(node.path);
    requireValue(!nodes.has(node.path) && typeof node.sha256 === 'string' && HASH.test(node.sha256), 'context.node', 'Duplicate node or invalid digest');
    stringList(node.reads, 'context.node.reads'); node.reads.forEach(relative);
    nodes.set(node.path, node);
  }
  const allVisited = new Set(), measured = {};
  for (const duty of DUTIES) {
    stringList(graph.roots[duty], `context.roots.${duty}`, 1);
    const wrapper = `.claude/agents/${input.policy.profiles[duty].wrapper}.md`;
    requireValue(graph.roots[duty].includes(wrapper), `context.roots.${duty}`, 'Declared wrapper must be a read root');
    const limit = graph.limits[duty];
    requireValue(Number.isSafeInteger(limit) && limit > 0, `context.limits.${duty}`, 'Positive ratchet limit required');
    const visited = new Set();
    const visit = path => {
      requireValue(nodes.has(path), 'context.nodes', 'Read dependency has no frozen node', 'MISSING_CONTEXT_SOURCE');
      if (visited.has(path)) return;
      visited.add(path); allVisited.add(path);
      const node = nodes.get(path), bytes = read(path);
      requireValue(bytesDigest(bytes) === node.sha256, path, 'Context source changed', 'CONTEXT_SOURCE_CHANGED');
      node.reads.forEach(visit);
    };
    graph.roots[duty].forEach(visit);
    const paths = [...visited].sort();
    const sourceBytes = paths.reduce((sum, path) => sum + read(path).length, 0);
    const briefBytes = duty === 'guard' ? 0 : Buffer.byteLength(preview.renderedBriefs[duty], 'utf8');
    const estimatedTokens = Math.ceil((sourceBytes + briefBytes) / 4);
    requireValue(estimatedTokens <= limit, `context.${duty}`, 'Declared read closure plus brief exceeds ratchet', 'CONTEXT_BUDGET_EXCEEDED');
    measured[duty] = { paths, sourceBytes, briefBytes, estimatedTokens, limit,
      completeInvocation: false, includesBrief: duty !== 'guard' };
  }
  requireValue(allVisited.size === nodes.size, 'context.nodes', 'Unreachable nodes in approved context graph');
  return measured;
}

export function preflight({ input: suppliedInput, teamRoot, approvalPath, expectedApprovalDigest }) {
  try {
    const input = parseJSON(canonical(suppliedInput));
    requireValue(typeof expectedApprovalDigest === 'string' && HASH.test(expectedApprovalDigest),
      'expectedApprovalDigest', 'Caller must supply a separately reviewed approval-file digest', 'APPROVAL_ANCHOR_REQUIRED');
    const root = resolve(teamRoot);
    requireValue(realpathSync(root) === root, 'teamRoot', 'Canonical non-symlink root required', 'UNSAFE_SOURCE_PATH');
    const snapshots = new Map(); let totalBytes = 0;
    const read = path => {
      relative(path);
      if (!snapshots.has(path)) {
        const bytes = readFile(root, path); totalBytes += bytes.length;
        requireValue(totalBytes <= 4 * 1024 * 1024, 'sources', 'Read bundle exceeds 4 MiB');
        snapshots.set(path, bytes);
      }
      return snapshots.get(path);
    };
    const approvalBytes = read(approvalPath);
    requireValue(bytesDigest(approvalBytes) === expectedApprovalDigest, 'approval', 'Approval file differs from caller trust anchor', 'APPROVAL_CHANGED');
    const approval = parseJSON(approvalBytes.toString('utf8'));
    fields(approval, ['schemaVersion', 'purpose', 'status', 'inputDigest', 'sources', 'context'], 'approval');
    requireValue(approval.schemaVersion === 1 && approval.purpose === 'offline-preflight' && approval.status === 'approved',
      'approval', 'Expected explicit offline-preflight approval');
    requireValue(approval.inputDigest === digest(input), 'input', 'Input differs from approved revision', 'INPUT_NOT_APPROVED');
    const needsMethods = input?.schemaVersion === 2 && (input.catalog?.methods?.length || input.proposal?.checkMethodIds?.length);
    const preview = compile(input, needsMethods ? { methodBundle: loadMethods({ teamRoot: root }) } : {});
    if (preview.errors) return preview;
    verifySources(input, approval, read);
    const context = measureContext(input, preview, approval.context, read);
    // Re-read the whole bundle before publishing evidence; caching is only for consistent measurement.
    for (const [path, bytes] of snapshots) requireValue(bytesDigest(readFile(root, path)) === bytesDigest(bytes),
      path, 'Source changed during preflight', 'SOURCE_CHANGED_DURING_PREFLIGHT');
    if (needsMethods) {
      const refreshed = compile(input, { methodBundle: loadMethods({ teamRoot: root }) });
      requireValue(!refreshed.errors && refreshed.manifest.digest === preview.manifest.digest,
        'methods', 'Method bundle changed during preflight', 'SOURCE_CHANGED_DURING_PREFLIGHT');
    }
    const body = {
      schemaVersion: 1, stage: 'offline-preflight', launchable: false,
      approvalFileDigest: expectedApprovalDigest, inputDigest: digest(input), previewDigest: preview.manifest.digest,
      files: [...snapshots].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: bytesDigest(bytes) })),
      context, metric: approval.context.metric,
      unresolved: ['human-approval-authenticity-and-revocation', 'semantic-read-closure-completeness',
        'runtime-injected-context', 'guardian-runtime-prompt', 'runtime-permissions-and-registry',
        'product-candidate-and-actual-diff', 'governance-coverage', 'usage-and-delivery-settlement'],
    };
    return { preview, preflight: { ...body, digest: digest(body) } };
  } catch (error) {
    if (error instanceof PreflightError || error instanceof MethodError) return { errors: [error.finding] };
    return { errors: [{ code: 'INVALID_PREFLIGHT', field: 'input', reason: 'Cannot read or validate the local preflight bundle' }] };
  }
}
