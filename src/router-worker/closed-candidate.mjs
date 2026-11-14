import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { snapshotRepository } from '../loop/snapshots.mjs';

// The product state a launch was closed with: commit plus every tracked and untracked
// (not ignored) file by content. A retry starts from exactly this state.
export const CLOSE_FILE = 'rw-close.json';

// Null when the product cannot be snapshotted (tracked symlink, submodule, size cap).
export function candidateOf(productRoot) {
  try {
    const snapshot = snapshotRepository({ root: productRoot, repoId: 'product' });
    return { id: snapshot.id, digest: digest(snapshot) };
  } catch { return null; }
}

// True when the copy holds the intact close record `closeDigest` and the product is still its candidate.
export function isClosedCandidate({ teamRoot, productRoot, closeDigest }) {
  let record;
  try { record = JSON.parse(readFileSync(join(teamRoot, CLOSE_FILE), 'utf8')); } catch { return false; }
  const { digest: recorded, ...body } = record ?? {};
  if (recorded !== closeDigest || recorded !== digest(body) || record.stage !== 'launch-closed' || !record.candidate) return false;
  return candidateOf(productRoot)?.digest === record.candidate.digest;
}
