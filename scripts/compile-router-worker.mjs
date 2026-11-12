import { openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { parseJSON } from '../src/loop/contracts.mjs';
import { compile } from '../src/router-worker/compile.mjs';
import { loadMethods, MethodError } from '../src/router-worker/methods.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('-')) {
  console.error('usage: node scripts/compile-router-worker.mjs <input.json> (offline preview only)');
  process.exitCode = 1;
} else {
  let fd;
  try {
    fd = openSync(args[0], 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Invalid input file');
    const input = parseJSON(readFileSync(fd, 'utf8'));
    const needsMethods = input?.schemaVersion === 2
      && (input.catalog?.methods?.length || input.proposal?.checkMethodIds?.length);
    const result = compile(input, needsMethods ? { methodBundle: loadMethods() } : {});
    if (result.errors) {
      console.error(JSON.stringify(result));
      process.exitCode = 2;
    } else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    console.error(JSON.stringify({ errors: [error instanceof MethodError ? error.finding
      : { code: 'INVALID_INPUT', field: 'input', reason: 'Expected a readable JSON file of at most 1 MiB with no duplicate keys' }] }));
    process.exitCode = 2;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
