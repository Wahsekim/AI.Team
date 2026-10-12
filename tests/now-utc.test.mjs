// scripts/now-utc.sh — host-generated UTC only (review 2026-09-25, recommendation 11).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/now-utc.sh', import.meta.url))

test('default output is an ISO-8601 UTC instant with a real Z suffix, independent of TZ', async () => {
  for (const TZ of ['Europe/Paris', 'America/Los_Angeles', 'Asia/Shanghai']) {
    const { stdout } = await exec('bash', [SCRIPT], { env: { ...process.env, TZ } })
    const s = stdout.trim()
    assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `TZ=${TZ}: ${s}`)
    assert.ok(Math.abs(Date.parse(s) - Date.now()) < 120_000, `TZ=${TZ}: not the current UTC instant: ${s}`)
  }
})

test('--date prints the UTC calendar date; unknown flags fail', async () => {
  const { stdout } = await exec('bash', [SCRIPT, '--date'], { env: { ...process.env, TZ: 'Pacific/Kiritimati' } })
  assert.equal(stdout.trim(), new Date().toISOString().slice(0, 10))
  await assert.rejects(exec('bash', [SCRIPT, '--local']), e => e.code === 1)
})
