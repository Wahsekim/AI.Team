// Security tests for scripts/watchdog/* (remediation plan P1-01):
// session_id path traversal, PID-file trust, and alert-state cleanup.
// HOME is pointed at a throwaway fixture dir so no real ~/.claude is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const DIR = fileURLToPath(new URL('../scripts/watchdog/', import.meta.url))

async function runHook(script, home, stdinJson) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(DIR, script)], { env: { ...process.env, HOME: home } })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => resolve({ code, out }))
    child.on('error', reject)
    child.stdin.end(stdinJson)
  })
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'ai-team-watchdog-'))
  try {
    await mkdir(join(home, '.claude', 'heartbeats'), { recursive: true })
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const exists = p => access(p).then(() => true, () => false)

test('heartbeat: valid session_id creates its heartbeat file', async () => {
  await withHome(async home => {
    const { code } = await runHook('heartbeat.sh', home, '{"session_id":"sess-Abc.123"}')
    assert.equal(code, 0)
    assert.ok(await exists(join(home, '.claude', 'heartbeats', 'sess-Abc.123.heartbeat')))
  })
})

test('heartbeat: traversal session_id cannot create files outside the heartbeat dir', async () => {
  await withHome(async home => {
    const { code } = await runHook('heartbeat.sh', home, '{"session_id":"../../pwned"}')
    assert.equal(code, 0)
    assert.ok(!(await exists(join(home, '.claude', 'pwned.heartbeat'))), 'traversal escaped the heartbeat dir')
    assert.ok(!(await exists(join(home, 'pwned.heartbeat'))), 'traversal escaped to HOME')
    const files = await readdir(join(home, '.claude', 'heartbeats'))
    assert.ok(files.every(f => f.startsWith('ppid-')), `expected PPID fallback, got: ${files}`)
  })
})

test('heartbeat: absolute-path and quote/newline session_ids fall back to PPID form', async () => {
  await withHome(async home => {
    for (const sid of ['/etc/cron.d/x', 'a b', 'x";rm -rf $HOME;"', 'a\\nb']) {
      const { code } = await runHook('heartbeat.sh', home, JSON.stringify({ session_id: sid }))
      assert.equal(code, 0)
    }
    const files = await readdir(join(home, '.claude', 'heartbeats'))
    assert.ok(files.every(f => f.startsWith('ppid-')), `unsafe id leaked into filename: ${files}`)
  })
})

test('heartbeat: resumed session cleans up stale .alerted files', async () => {
  await withHome(async home => {
    const hb = join(home, '.claude', 'heartbeats')
    await writeFile(join(hb, 's1.heartbeat.alerted-123'), '')
    const { code } = await runHook('heartbeat.sh', home, '{"session_id":"s1"}')
    assert.equal(code, 0)
    assert.ok(!(await exists(join(hb, 's1.heartbeat.alerted-123'))))
    assert.ok(await exists(join(hb, 's1.heartbeat')))
  })
})

test('stop: PID file pointing at a non-watchdog process must NOT kill it', async () => {
  await withHome(async home => {
    const victim = spawn('sleep', ['300'])
    try {
      const hb = join(home, '.claude', 'heartbeats')
      await writeFile(join(hb, 's2.watchdog-pid'), String(victim.pid))
      await writeFile(join(hb, 's2.heartbeat'), '')
      const { code } = await runHook('stop-watchdog.sh', home, '{"session_id":"s2"}')
      assert.equal(code, 0)
      assert.equal(victim.exitCode, null, 'stop-watchdog killed an unrelated process (PID reuse hazard)')
      assert.ok(!(await exists(join(hb, 's2.watchdog-pid'))), 'stale PID file should be removed')
      assert.ok(!(await exists(join(hb, 's2.heartbeat'))), 'heartbeat should be removed as stop signal')
    } finally {
      victim.kill('SIGKILL')
    }
  })
})

test('stop: garbage PID file content is handled without error', async () => {
  await withHome(async home => {
    const hb = join(home, '.claude', 'heartbeats')
    await writeFile(join(hb, 's3.watchdog-pid'), 'abc; rm -rf /\n')
    const { code } = await runHook('stop-watchdog.sh', home, '{"session_id":"s3"}')
    assert.equal(code, 0)
    assert.ok(!(await exists(join(hb, 's3.watchdog-pid'))))
  })
})

test('stop: traversal session_id cannot delete files outside the heartbeat dir', async () => {
  await withHome(async home => {
    const outside = join(home, '.claude', 'precious.heartbeat')
    await writeFile(outside, 'keep me')
    const { code } = await runHook('stop-watchdog.sh', home, '{"session_id":"../precious"}')
    assert.equal(code, 0)
    assert.ok(await exists(outside), 'traversal deleted a file outside the heartbeat dir')
  })
})

test('N-08: loop survives the alert state and resumes when the heartbeat returns', async () => {
  await withHome(async home => {
    const hb = join(home, '.claude', 'heartbeats')
    // Alert state: heartbeat set aside as .alerted-<ts>, no live heartbeat.
    await writeFile(join(hb, 's9.heartbeat.alerted-123'), '')
    const loop = spawn('bash', [join(DIR, 'watchdog-loop.sh'), 's9'], {
      env: { ...process.env, HOME: home, WATCHDOG_INTERVAL: '0.1', WATCHDOG_THRESHOLD: '600' },
    })
    try {
      await new Promise(r => setTimeout(r, 600))
      assert.equal(loop.exitCode, null, 'loop must WAIT during the alert state, not exit (or monitoring never resumes)')
      // Clean shutdown: remove the alert marker with no heartbeat -> loop exits.
      await rm(join(hb, 's9.heartbeat.alerted-123'))
      await new Promise(r => setTimeout(r, 800))
      assert.notEqual(loop.exitCode, null, 'loop must exit cleanly once neither heartbeat nor alert state exists')
    } finally {
      loop.kill('SIGKILL')
    }
  })
})

test('N-08: stop must not kill a watchdog loop belonging to ANOTHER session', async () => {
  await withHome(async home => {
    const hb = join(home, '.claude', 'heartbeats')
    // A loop for session OTHER, alive via its own heartbeat.
    await writeFile(join(hb, 'OTHER.heartbeat'), '')
    const other = spawn('bash', [join(DIR, 'watchdog-loop.sh'), 'OTHER'], {
      env: { ...process.env, HOME: home, WATCHDOG_INTERVAL: '0.2', WATCHDOG_THRESHOLD: '600' },
    })
    try {
      // s10's stale PID file wrongly points at OTHER's loop process (PID reuse shape).
      await writeFile(join(hb, 's10.watchdog-pid'), String(other.pid))
      await writeFile(join(hb, 's10.heartbeat'), '')
      const { code } = await runHook('stop-watchdog.sh', home, '{"session_id":"s10"}')
      assert.equal(code, 0)
      await new Promise(r => setTimeout(r, 300))
      assert.equal(other.exitCode, null, "another session's watchdog must not be killed (session-bound PID check)")
    } finally {
      other.kill('SIGKILL')
    }
  })
})

test('start: stale PID file with reused non-watchdog PID is cleaned and respawned over', async () => {
  await withHome(async home => {
    const victim = spawn('sleep', ['300'])
    try {
      const hb = join(home, '.claude', 'heartbeats')
      await writeFile(join(hb, 's4.watchdog-pid'), String(victim.pid))
      const { code } = await runHook('start-watchdog.sh', home, '{"session_id":"s4"}')
      assert.equal(code, 0)
      assert.equal(victim.exitCode, null, 'start-watchdog must never signal a foreign PID')
      // A real watchdog-loop was spawned; its PID file must now point at a watchdog process.
      const pidRaw = (await import('node:fs/promises').then(fs => fs.readFile(join(hb, 's4.watchdog-pid'), 'utf8'))).trim()
      assert.notEqual(pidRaw, String(victim.pid), 'stale foreign PID must not be kept')
      // Clean up the spawned loop via the stop hook.
      await runHook('stop-watchdog.sh', home, '{"session_id":"s4"}')
    } finally {
      victim.kill('SIGKILL')
    }
  })
})
