import { digest, fields, id, pathRef, ref, requireThat, validateRunSpec } from './contracts.mjs';

// The host supplies a frozen bundle, never an agent-selected path or URL.
export function resolveRef(reference, artifacts) {
  ref(reference);
  requireThat(Object.hasOwn(artifacts, reference.id), 'UNKNOWN_REFERENCE', `Missing artifact ${reference.id}`);
  const value = artifacts[reference.id];
  requireThat(digest(value) === reference.digest, 'INVALID_SPEC', `Artifact digest mismatch: ${reference.id}`);
  return value;
}

export function validateBundle(spec, artifacts) {
  validateRunSpec(spec);
  const manifest = resolveRef(spec.manifestRef, artifacts);
  fields(manifest, ['schemaVersion', 'roles', 'scopes', 'gates', 'approvalPolicy', 'retentionPolicy'], 'Manifest');
  requireThat(manifest.schemaVersion === 1 && manifest.approvalPolicy === 'local-attended'
    && manifest.retentionPolicy === 'manual', 'CAPABILITY_MISSING', 'Unsupported manifest policy');
  const unique = (entries, label) => {
    requireThat(Array.isArray(entries), 'INVALID_SPEC', `${label} must be an array`);
    entries.forEach(e => id(e.id));
    requireThat(new Set(entries.map(e => e.id)).size === entries.length, 'INVALID_SPEC', `Duplicate ${label}`);
    return new Map(entries.map(e => [e.id, e]));
  };
  const roles = unique(manifest.roles, 'roles'), scopes = unique(manifest.scopes, 'scopes'), gates = unique(manifest.gates, 'gates');
  for (const r of roles.values()) {
    fields(r, ['id', 'scopeIds', 'adapter'], 'Role');
    requireThat(Array.isArray(r.scopeIds), 'INVALID_SPEC', 'scopeIds must be array');
    r.scopeIds.forEach(scope => { id(scope); requireThat(scopes.has(scope), 'UNKNOWN_REFERENCE', 'Unknown role scope'); });
    requireThat(r.adapter === 'mock', 'CAPABILITY_MISSING', 'Live agents are not enabled');
  }
  for (const scope of scopes.values()) {
    fields(scope, ['id', 'writePaths'], 'Scope');
    requireThat(Array.isArray(scope.writePaths), 'INVALID_SPEC', 'writePaths must be array'); scope.writePaths.forEach(pathRef);
  }
  for (const gate of gates.values()) { fields(gate, ['id', 'artifactRef'], 'Gate binding'); resolveRef(gate.artifactRef, artifacts); }
  resolveRef(spec.initialSnapshotRef, artifacts);
  for (const task of spec.tasks) {
    requireThat(roles.has(task.roleId) && scopes.has(task.scopeId), 'UNKNOWN_REFERENCE', 'Unknown role or scope');
    requireThat(roles.get(task.roleId).scopeIds.includes(task.scopeId), 'SCOPE_DENIED', 'Role is not authorized for task scope');
    if (task.mutatesProduct) requireThat(scopes.get(task.scopeId).writePaths.some(p => p.repoId === 'product'), 'SCOPE_DENIED', 'No product write scope');
    const brief = resolveRef(task.briefRef, artifacts);
    requireThat(typeof brief === 'string' && Buffer.byteLength(brief) <= 200 * 1024, 'INVALID_SPEC', 'Brief must be text <=200 KiB');
    task.requiredGateIds.forEach(g => requireThat(gates.has(g), 'UNKNOWN_REFERENCE', `Unknown gate ${g}`));
  }
  return manifest;
}
