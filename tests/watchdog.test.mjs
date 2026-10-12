// Security tests for scripts/watchdog/* (remediation plan P1-01):
// session_id path traversal, PID-file trust, and alert-state cleanup.
// HOME is pointed at a throwaway fixture dir so no real ~/.claude is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, access, utimes } from 'node:fs/promises'
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

test('R-10: concurrent SessionStart hooks spawn at most one loop (start lock)', async () => {
  await withHome(async home => {
    const [a, b] = await Promise.all([
      runHook('start-watchdog.sh', home, '{"session_id":"s11"}'),
      runHook('start-watchdog.sh', home, '{"session_id":"s11"}'),
    ])
    try {
      assert.equal(a.code, 0)
      assert.equal(b.code, 0)
      const { stdout } = await new Promise(res => {
        const c = spawn('sh', ['-c', 'ps ax -o command= | grep "watchdog-loop.sh s11" | grep -v grep | wc -l'])
        let out = ''
        c.stdout.on('data', d => { out += d })
        c.on('close', () => res({ stdout: out }))
      })
      assert.ok(parseInt(stdout.trim(), 10) <= 1, `expected at most one loop, got ${stdout.trim()}`)
    } finally {
      await runHook('stop-watchdog.sh', home, '{"session_id":"s11"}')
    }
  })
})

test('R02-FIX-1: start lock is held until the spawned loop has exec\'d (no second loop from a pre-exec PID)', async () => {
  await withHome(async home => {
    const hb = join(home, '.claude', 'heartbeats')
    // A FIFO stdout log blocks the spawned child in its pre-exec redirection,
    // where its argv is still start-watchdog.sh's: a racing start must not read
    // that PID as stale and spawn a second loop.
    const fifo = join(home, '.claude', 'watchdog.stdout.log')
    await exec('mkfifo', [fifo])
    const first = runHook('start-watchdog.sh', home, '{"session_id":"s15"}')
    let reader
    try {
      const deadline = Date.now() + 5000
      while (!(await readFile(join(hb, 's15.watchdog-pid'), 'utf8').catch(() => '')).trim()) {
        assert.ok(Date.now() < deadline, 'first start never wrote its PID file within 5s')
        await new Promise(r => setTimeout(r, 10))
      }
      // stdio ignored: an unfixed second start's own child would block on the
      // FIFO holding inherited pipes open; wait for the hook's exit, not close.
      const second = spawn('bash', [join(DIR, 'start-watchdog.sh')], {
        env: { ...process.env, HOME: home }, stdio: ['pipe', 'ignore', 'ignore'],
      })
      second.stdin.end('{"session_id":"s15"}')
      assert.equal(await new Promise(r => second.on('exit', r)), 0)
      reader = spawn('cat', [fifo], { stdio: ['ignore', 'ignore', 'ignore'] })
      assert.equal((await first).code, 0)
      const { stdout } = await exec('sh', ['-c', 'ps ax -o command= | grep "watchdog-loop.sh s15$" | grep -v grep | wc -l'])
      assert.equal(parseInt(stdout.trim(), 10), 1, `expected exactly one loop, got ${stdout.trim()}`)
    } finally {
      // Always open the FIFO so a still-blocked child can exec and the first
      // hook can close; only then stop the loop(s) and drop the reader.
      reader ??= spawn('cat', [fifo], { stdio: ['ignore', 'ignore', 'ignore'] })
      await first
      await runHook('stop-watchdog.sh', home, '{"session_id":"s15"}')
      await exec('sh', ['-c', 'pkill -f "watchdog-loop.sh s15$" || true'])
      reader.kill('SIGKILL')
    }
  })
})

test('R-10: stop clears alert-state markers so no orphan loop lingers', async () => {
  await withHome(async home => {
    const hb = join(home, '.claude', 'heartbeats')
    await writeFile(join(hb, 's12.heartbeat'), '')
    await writeFile(join(hb, 's12.heartbeat.alerted-42'), '')
    const { code } = await runHook('stop-watchdog.sh', home, '{"session_id":"s12"}')
    assert.equal(code, 0)
    assert.ok(!(await exists(join(hb, 's12.heartbeat'))))
    assert.ok(!(await exists(join(hb, 's12.heartbeat.alerted-42'))), 'alert markers must be cleared on stop')
  })
})

test('R-10: bogus WATCHDOG_* env values fall back to defaults (no busy-spin, clean exit)', async () => {
  await withHome(async home => {
    // No heartbeat + no alert state -> a healthy loop exits immediately on its
    // first check; a busy-spinning or arithmetic-crashed loop would not.
    const loop = spawn('bash', [join(DIR, 'watchdog-loop.sh'), 's13'], {
      env: { ...process.env, HOME: home, WATCHDOG_INTERVAL: 'evil; rm -rf /', WATCHDOG_THRESHOLD: '-5', WATCHDOG_MAX_LIFETIME: 'NaN' },
    })
    try {
      await new Promise(r => setTimeout(r, 1500))
      assert.notEqual(loop.exitCode, null, 'loop must run its check loop and exit cleanly despite bogus env')
      assert.equal(loop.exitCode, 0)
    } finally {
      loop.kill('SIGKILL')
    }
  })
})

test('R5-12b: fractional WATCHDOG_THRESHOLD falls back to an integer — stale alert still fires', async () => {
  await withHome(async home => {
    const hb = join(home, '.claude', 'heartbeats')
    await writeFile(join(hb, 's14.heartbeat'), '')
    // Older than the 600s integer fallback the fractional value must map to.
    const past = Math.floor(Date.now() / 1000) - 700
    await utimes(join(hb, 's14.heartbeat'), past, past)
    const loop = spawn('bash', [join(DIR, 'watchdog-loop.sh'), 's14'], {
      env: { ...process.env, HOME: home, WATCHDOG_INTERVAL: '0.1', WATCHDOG_THRESHOLD: '0.5', WATCHDOG_MAX_LIFETIME: '30' },
    })
    let err = ''
    loop.stderr.on('data', d => { err += d })
    try {
      await new Promise(r => setTimeout(r, 800))
      assert.ok(!/integer expression/.test(err), `staleness compare crashed on fractional threshold: ${err}`)
      const log = await readFile(join(home, '.claude', 'hang-log.jsonl'), 'utf8')
      assert.match(log, /"session_id":"s14".*"event":"heartbeat_stale"/, 'stale alert must fire, not error out every pass')
    } finally {
      loop.kill('SIGKILL')
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
