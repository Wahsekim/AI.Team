import { realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

// decisions/0009-kit-instance-separation.md: project authority comes from the
// instance root, universal sources from the kit that the instance pins at kit/.
export function instanceOf(kitRoot, instanceRoot) {
  if (instanceRoot === undefined || instanceRoot === null) return null;
  if (typeof instanceRoot !== 'string') throw Error('Instance root must be a path');
  const root = resolve(instanceRoot);
  if (realpathSync(root) !== root) throw Error('Canonical instance root required');
  if (realpathSync(join(root, 'kit')) !== resolve(kitRoot)) throw Error('Instance kit/ is not the kit serving this call');
  const lock = lstatSync(join(root, 'kit.lock'), { throwIfNoEntry: false });
  if (!lock?.isFile()) throw Error('Instance kit.lock is missing');
  return root;
}

export function existsIn(root, path) {
  return Boolean(lstatSync(join(root, path), { throwIfNoEntry: false }));
}
