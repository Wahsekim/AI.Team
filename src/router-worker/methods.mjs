import { openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, bytesDigest, parseJSON } from '../loop/contracts.mjs';
import { renderBlastRadius } from './adapters/blast-radius.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CATALOG_PATH = 'config/router-worker/catalog.json';
const LOCK_PATH = 'agents/skill-packs/lock.json';
const SOURCE_PATH = 'agents/skill-packs/pstack/skills/blast-radius/SKILL.md';
const LICENSE_PATH = 'agents/skill-packs/pstack/LICENSE';
const ADAPTER_PATH = 'src/router-worker/adapters/blast-radius.mjs';
const HASH = /^sha256:[a-f0-9]{64}$/;
const bundles = new WeakMap();
// Bind this process's adapter load, not a later edit of the file on disk.
const EXECUTING_ADAPTER_DIGEST = bytesDigest(readFileSync(new URL('./adapters/blast-radius.mjs', import.meta.url)));

export class MethodError extends Error {
  constructor(code, reason) {
    super(reason);
    this.finding = { code, field: 'methods', reason };
  }
}

function check(condition, reason, code = 'METHOD_INTEGRITY_FAILED') {
  if (!condition) throw new MethodError(code, reason);
}

function fields(value, keys) {
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'Missing or unknown catalog fields');
}

function readPinnedFile(root, relative) {
  // Paths come only from the adapter's fixed read set, never from task text.
  let current = root;
  for (const component of relative.split('/')) {
    current = join(current, component);
    check(!lstatSync(current).isSymbolicLink(), 'Symlink in pinned method read set');
  }
  const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.size <= 1024 * 1024, 'Pinned method input must be a regular file of at most 1 MiB');
    const bytes = readFileSync(fd);
    check(bytes.length <= 1024 * 1024, 'Pinned method input exceeds 1 MiB');
    return bytes;
  } finally { closeSync(fd); }
}

function validateEntry(entry, lock) {
  fields(entry, ['id', 'allowedModes', 'allowedDuties', 'description', 'triggers', 'exclusions', 'requiredInputs',
    'source', 'sourceRepo', 'sourceCommit', 'sourceLockRef', 'files', 'adapterVersion', 'adapterPath',
    'adapterDigest', 'dependencyRefs', 'licenseRefs']);
  check(entry.id === 'pstack-blast-radius' && entry.source === 'pstack'
    && entry.sourceRepo === 'https://github.com/cursor/plugins.git', 'Unsupported method/source');
  check(canonical(entry.allowedModes) === canonical(['router-worker'])
    && canonical(entry.allowedDuties) === canonical(['check']), 'Method cannot gain another mode or duty');
  check(canonical(entry.requiredInputs) === canonical(['baseline.candidateRef', 'policy.verificationCommands'])
    && canonical(entry.dependencyRefs) === '[]'
    && canonical(entry.licenseRefs) === canonical([LICENSE_PATH]), 'Unreviewed dependency or missing license');
  for (const values of [[entry.description], entry.triggers, entry.exclusions]) {
    check(Array.isArray(values) && values.length > 0 && values.length <= 20
      && values.every(v => typeof v === 'string' && v.trim() && v.length <= 1000 && !/[\x00-\x1f\x7f]/.test(v)), 'Invalid catalog description');
  }
  fields(entry.sourceLockRef, ['path', 'key', 'digest']);
  check(entry.sourceLockRef.path === LOCK_PATH && entry.sourceLockRef.key === 'pstack', 'Unsupported lock reference');
  check(lock && typeof lock.commit === 'string' && /^[a-f0-9]{40}$/.test(lock.commit)
    && entry.sourceCommit === lock.commit && entry.sourceLockRef.digest === digest(lock), 'Source lock changed; review and repin catalog');
  check(entry.adapterVersion === 'blast-radius-check-v1' && entry.adapterPath === ADAPTER_PATH
    && typeof entry.adapterDigest === 'string' && HASH.test(entry.adapterDigest), 'Unsupported adapter');
  check(Array.isArray(entry.files) && entry.files.length === 2, 'Unexpected method read closure');
  for (const [index, expected] of [LICENSE_PATH, SOURCE_PATH].entries()) {
    const file = entry.files[index];
    fields(file, ['path', 'sha256']);
    check(file.path === expected && typeof file.sha256 === 'string' && HASH.test(file.sha256), 'Unexpected source file or hash');
    const upstreamPath = expected.slice('agents/skill-packs/pstack/'.length);
    check(file.sha256 === `sha256:${lock.files?.[upstreamPath]}`, 'Catalog and source lock disagree');
  }
}

export function loadMethods({ teamRoot = DEFAULT_ROOT } = {}) {
  try {
    const root = resolve(teamRoot);
    check(realpathSync(root) === root, 'Method root must be a canonical, non-symlink path');
    const catalog = parseJSON(readPinnedFile(root, CATALOG_PATH).toString('utf8'));
    fields(catalog, ['schemaVersion', 'methods']);
    check(catalog.schemaVersion === 1 && Array.isArray(catalog.methods) && catalog.methods.length === 1, 'Unsupported catalog');
    const entry = catalog.methods[0];
    const lock = parseJSON(readPinnedFile(root, LOCK_PATH).toString('utf8'));
    validateEntry(entry, lock.pstack);
    const sourceBytes = new Map(entry.files.map(file => {
      const bytes = readPinnedFile(root, file.path);
      check(bytesDigest(bytes) === file.sha256, 'Pinned source/license hash mismatch');
      return [file.path, bytes];
    }));
    const adapterBytes = readPinnedFile(root, ADAPTER_PATH);
    check(bytesDigest(adapterBytes) === entry.adapterDigest, 'Adapter hash mismatch');
    check(EXECUTING_ADAPTER_DIGEST === entry.adapterDigest,
      'Requested adapter does not match the executing adapter version');
    const body = renderBlastRadius(sourceBytes.get(SOURCE_PATH).toString('utf8'));
    const receipt = {
      id: entry.id, duty: 'check', sourceCommit: entry.sourceCommit, sourceLockDigest: entry.sourceLockRef.digest,
      files: entry.files, adapterVersion: entry.adapterVersion, adapterDigest: entry.adapterDigest,
      renderedDigest: bytesDigest(body), licenseRefs: entry.licenseRefs,
    };
    const token = Object.freeze(Object.create(null));
    bundles.set(token, { catalog, body, receipt });
    return token;
  } catch (error) {
    if (error instanceof MethodError) throw error;
    throw new MethodError('METHOD_INTEGRITY_FAILED', 'Cannot read or validate the pinned method bundle');
  }
}

export function methodCatalog(bundle) {
  check(bundles.has(bundle), 'A loader-verified method bundle is required', 'METHOD_BUNDLE_REQUIRED');
  return parseJSON(canonical(bundles.get(bundle).catalog));
}

export function selectMethods(bundle, catalog, ids, duty, allowlist) {
  if (!ids.length) return [];
  check(ids.length === 1 && ids[0] === 'pstack-blast-radius' && duty === 'check' && allowlist.includes(ids[0]),
    'Method is not approved for this duty/policy', 'METHOD_NOT_ALLOWED');
  check(bundles.has(bundle), 'A loader-verified method bundle is required', 'METHOD_BUNDLE_REQUIRED');
  const verified = bundles.get(bundle);
  check(canonical(catalog) === canonical(verified.catalog), 'Input catalog differs from the verified bundle', 'METHOD_CATALOG_MISMATCH');
  return [{ receipt: parseJSON(canonical(verified.receipt)), body: verified.body }];
}
