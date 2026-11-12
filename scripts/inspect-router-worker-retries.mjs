import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { openRetryStore } from '../src/router-worker/retry-store.mjs';

const [filename, ticketId, ...extra] = process.argv.slice(2);
if (!filename || !ticketId || extra.length) {
  console.error('usage: node scripts/inspect-router-worker-retries.mjs <absolute-file.rw-retries.sqlite> <ticket-id> (read-only; never starts work)');
  process.exitCode = 1;
} else {
  let store;
  try {
    store = await openRetryStore({ filename, ticketId, rules: loadRetryRules(), readOnly: true });
    process.stdout.write(JSON.stringify({ stage: 'offline-retry-inspection', ...store.read() }, null, 2) + '\n');
  } catch (error) {
    console.error(JSON.stringify({ errors: [{ code: error.code ?? 'RETRY_INSPECTION_FAILED', field: 'store', reason: error.message }] }));
    process.exitCode = 2;
  } finally { store?.close(); }
}
