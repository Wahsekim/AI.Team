import { writeSync } from 'node:fs';
import { openFixtureAdapter } from '../../src/loop/adapters/fixture-process.mjs';

const [filename, workspace, boundary] = process.argv.slice(2);
const adapter = await openFixtureAdapter({ filename, workspace, runId: 'crash-run', onBoundary(event) {
  if (event.phase !== boundary) return;
  writeSync(1, `${JSON.stringify(event)}\n`);
  // The parent kills this actual host process after observing the precise
  // durability boundary. Do not simulate death by throwing or setting a flag.
  // Self-exit bounds an unkilled host.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  process.exit(9);
} });
const handle = adapter.start('d-1', { scenario: 'pass', delayMs: 200, timeoutMs: 2000 });
await adapter.collectResult(handle);
await adapter.close();
throw new Error('Requested crash boundary was not reached');
