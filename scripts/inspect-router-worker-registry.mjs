import { openSync, closeSync, fstatSync, readFileSync, realpathSync, constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { bytesDigest, parseJSON, requireThat } from '../src/loop/contracts.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { openRetryRegistry } from '../src/router-worker/retry-registry.mjs';

const [filename, expectedDigest, ticketId, ...extra] = process.argv.slice(2);
if (!filename || !expectedDigest || !ticketId || extra.length) {
  console.error('usage: node scripts/inspect-router-worker-registry.mjs <absolute-anchor.json> <sha256:anchor-file-digest> <ticket-id> (read-only; never repairs or starts work)');
  process.exitCode = 1;
} else {
  let fd, ticket;
  try {
    requireThat(isAbsolute(filename) && resolve(filename) === filename && realpathSync(filename) === filename,
      'INVALID_REGISTRY_ANCHOR', 'Canonical absolute anchor file required');
    requireThat(/^sha256:[a-f0-9]{64}$/.test(expectedDigest), 'INVALID_REGISTRY_ANCHOR', 'Supply the separately retained anchor-file digest');
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    requireThat(stat.isFile() && stat.size <= 65536, 'INVALID_REGISTRY_ANCHOR', 'Anchor must be a bounded regular file');
    const bytes = readFileSync(fd);
    requireThat(bytes.length <= 65536 && bytesDigest(bytes) === expectedDigest,
      'REGISTRY_ANCHOR_MISMATCH', 'Anchor file differs from its separately supplied digest');
    const registry = openRetryRegistry({ anchor: parseJSON(bytes.toString('utf8')), rules: loadRetryRules() });
    ticket = await registry.openTicket(ticketId, { readOnly: true });
    process.stdout.write(JSON.stringify({ stage: 'offline-registry-inspection', ...ticket.read() }, null, 2) + '\n');
  } catch (error) {
    console.error(JSON.stringify({ errors: [{ code: error.code ?? 'REGISTRY_INSPECTION_FAILED', field: 'registry', reason: error.message }] }));
    process.exitCode = 2;
  } finally {
    ticket?.close();
    if (fd !== undefined) closeSync(fd);
  }
}
