import { digest } from '../loop/contracts.mjs';
import { snapshotRepository } from '../loop/snapshots.mjs';

export const CLOSE_FILE = 'rw-close.json';

// The product state a launch is closed with: commit plus every tracked and untracked
// (not ignored) file by content.
// Null when the product cannot be snapshotted (tracked symlink, submodule, size cap).
export function candidateOf(productRoot) {
  try {
    const snapshot = snapshotRepository({ root: productRoot, repoId: 'product' });
    return { id: snapshot.id, digest: digest(snapshot) };
  } catch { return null; }
}
