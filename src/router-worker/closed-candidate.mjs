import { digest } from '../loop/contracts.mjs';
import { snapshotRepository } from '../loop/snapshots.mjs';

// The product state a launch was closed with: commit plus every tracked and untracked
// (not ignored) file by content.
export const CLOSE_FILE = 'rw-close.json';

// Null when the product cannot be snapshotted (tracked symlink, submodule, size cap).
export function candidateOf(productRoot) {
  try {
    const snapshot = snapshotRepository({ root: productRoot, repoId: 'product' });
    return { id: snapshot.id, digest: digest(snapshot) };
  } catch { return null; }
}
