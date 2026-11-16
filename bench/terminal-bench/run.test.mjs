import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'run.sh')
const KEY = 'test-provider-key-not-real-7f3a'
const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Stand-ins for Harbor and Docker. The Harbor stub records its argv and the key it was handed,
// then plays one trial whose events report STUB_COST; with STUB_HANG it keeps running until
// it is stopped, like a job mid-run, and records the SIGTERM that stops it. The Docker stub
// lists this job's two containers and a stranger's, and records every call.
const HARBOR_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_LOG/argv"
printf '%s' "\${ANTHROPIC_API_KEY-unset}" > "$STUB_LOG/key"
while [ $# -gt 0 ]; do
  case $1 in -o) out=$2; shift ;; --job-name) job=$2; shift ;; esac
  shift
done
trial="$out/$job/fin-saccr-rwa__AbC123/agent"
mkdir -p "$trial"
printf '{"event_type": "session_update", "payload": {"update": {"sessionUpdate": "usage_update", "cost": {"amount": %s, "currency": "USD"}}}}\\n' "$STUB_COST" > "$trial/acp-events.jsonl"
if [ "\${STUB_HANG-}" = 1 ]; then
  trap 'echo TERM >> "$STUB_LOG/harbor-signals"; kill "$s" 2>/dev/null; exit 143' TERM
  sleep 30 &
  s=$!
  : > "$STUB_LOG/harbor-ready"
  wait "$s"
fi
exit 0
`
const DOCKER_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG/docker"
if [ "$1" = ps ]; then
  printf '%s\\n' 'c1 fin-saccr-rwa__abc123__env' 'c2 fin-saccr-rwa__abc123__verifier__main' 'c3 fin-saccr-rwa__zzz999__env' 'c4 unrelated'
fi
`

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-run-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  const log = join(dir, 'log')
  mkdirSync(bin)
  mkdirSync(log)
  writeFileSync(join(bin, 'harbor'), HARBOR_STUB)
  writeFileSync(join(bin, 'docker'), DOCKER_STUB)
  chmodSync(join(bin, 'harbor'), 0o755)
  chmodSync(join(bin, 'docker'), 0o755)
  return { dir, bin, log, jobs: join(dir, 'jobs') }
}

/**
 * Runs run.sh hermetically: only the stubs, node and the base system tools are reachable.
 * Jobs go to t.jobs unless `jobsDir` is false, which leaves the default to run.sh. `kit` runs
 * a copy of the kit instead (see brokenGuardKit).
 */
function run(t, args, env = {}, { jobsDir = true, kit = null } = {}) {
  const res = spawnSync('bash', [kit ? join(kit, 'run.sh') : script, ...(jobsDir ? ['--jobs-dir', t.jobs] : []), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: stubEnv(t, env)
  })
  return { ...res, ...stubLogs(t) }
}

function stubEnv(t, env) {
  return {
    PATH: `${t.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HARBOR: join(t.bin, 'harbor'),
    DOCKER: join(t.bin, 'docker'),
    STUB_LOG: t.log,
    STUB_COST: '0.5',
    BENCH_POLL_SECONDS: '0.2',
    BENCH_STOP_GRACE: '5',
    ...env
  }
}

function stubLogs(t) {
  const read = (name) => (existsSync(join(t.log, name)) ? readFileSync(join(t.log, name), 'utf8') : null)
  return { argv: read('argv')?.split('\n').filter(Boolean) ?? null, key: read('key'), docker: read('docker'), harborSignals: read('harbor-signals') }
}

async function waitFor(check, what) {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** A copy of the kit whose spend check always crashes, as a bug in it would. */
function brokenGuardKit(t) {
  const kit = join(t.dir, 'kit')
  mkdirSync(kit)
  for (const file of ['run.sh', 'agent-entry.mjs', 'agent.json', 'tasks.txt']) {
    copyFileSync(join(dirname(script), file), join(kit, file))
  }
  writeFileSync(join(kit, 'spend.mjs'), "throw new Error('spend check broke')\n")
  return kit
}

describe.skipIf(process.platform === 'win32')('run.sh', () => {
  it('runs every task in tasks.txt, handing Harbor the key by reference only', () => {
    const t = setup()
    const res = run(t, ['--cap', '5', 'pilot', 'anthropic/claude-opus-5-5'], { ANTHROPIC_API_KEY: KEY })
    expect(res.status).toBe(0)
    expect(res.key).toBe(KEY)
    expect(res.argv).toContain('ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}')
    expect(res.argv.join('\n')).not.toContain(KEY)
    expect(`${res.stdout}${res.stderr}`).not.toContain(KEY)
    expect(res.argv.slice(0, 3)).toEqual(['run', '-d', 'terminal-bench/terminal-bench@4.1.0'])
    expect(res.argv.filter((a) => a === '--include-task-name')).toHaveLength(8)
    expect(res.argv).toContain('terminal-bench/fin-saccr-rwa')
    expect(res.argv).not.toContain('--mounts')
    expect(res.stdout).toContain('TOTAL $0.50 over 1 trials')
    const entry = JSON.parse(readFileSync(join(t.jobs, 'pilot.agent.json'), 'utf8'))
    expect(entry.distribution.npx.package).toBe('@houston-code/cli@latest')
    expect(res.argv).toContain(`registry_entry_path=${join(t.jobs, 'pilot.agent.json')}`)
  })

  it('keeps jobs under ~/.cache/houston-bench/jobs by default, outside any checkout', () => {
    const t = setup()
    const res = run(t, ['--cap', '5', 'home', 'anthropic/claude-opus-5-5', 'fin-saccr-rwa'], { ANTHROPIC_API_KEY: KEY, HOME: t.dir }, { jobsDir: false })
    expect(res.status).toBe(0)
    const jobs = join(t.dir, '.cache', 'houston-bench', 'jobs')
    expect(res.argv.slice(-2)).toEqual(['-o', jobs])
    expect(existsSync(join(jobs, 'home', 'fin-saccr-rwa__AbC123'))).toBe(true)
    expect(existsSync(join(jobs, 'home.spend'))).toBe(true)
  })

  it('mounts only the local package, read-only, and launches it from the generated entry', () => {
    const t = setup()
    const pkg = join(t.dir, 'dist', 'houston-code-cli-0.12.0.tgz')
    mkdirSync(dirname(pkg))
    writeFileSync(pkg, '')
    // A file next to the tarball must stay out of the task container.
    writeFileSync(join(dirname(pkg), 'private-notes.txt'), 'not for the agent')
    const res = run(t, ['--cap', '5', '--pkg', pkg, '--label', 'main.abc1234', 'local', 'anthropic/claude-haiku-5-5', 'ks-solver-cpp'], {
      ANTHROPIC_API_KEY: KEY
    })
    expect(res.status).toBe(0)
    expect(res.argv.filter((a) => a === '--include-task-name')).toHaveLength(1)
    const mounts = JSON.parse(res.argv[res.argv.indexOf('--mounts') + 1])
    expect(mounts).toEqual([{ type: 'bind', source: pkg, target: '/opt/houston-pkg/houston-code-cli-0.12.0.tgz', read_only: true }])
    const entry = JSON.parse(readFileSync(join(t.jobs, 'local.agent.json'), 'utf8'))
    expect(entry.version).toBe('0.12.0+main.abc1234')
    expect(entry.distribution.npx.package).toBe('--package=/opt/houston-pkg/houston-code-cli-0.12.0.tgz')
  })

  it('stops the job once the reported spend reaches the cap, removing only its containers', () => {
    const t = setup()
    const started = Date.now()
    const res = run(t, ['--cap', '1', 'capped', 'anthropic/claude-opus-5-5', 'fin-saccr-rwa'], {
      ANTHROPIC_API_KEY: KEY,
      STUB_COST: '1.5',
      STUB_HANG: '1'
    })
    expect(res.status).toBe(3)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(res.stderr).toContain('reached the $1 cap')
    expect(res.docker).toContain('rm -f c1')
    expect(res.docker).toContain('rm -f c2')
    expect(res.docker).not.toContain('c3')
    expect(res.docker).not.toContain('c4')
    expect(res.harborSignals).toBe('TERM\n')
    expect(readFileSync(join(t.jobs, 'capped.spend'), 'utf8')).toContain('TOTAL $1.50')
  })

  it('stops the job the same way when the terminal hangs up', async () => {
    const t = setup()
    // Its own process group, like a terminal's foreground job, so the hangup can go to all of it.
    const child = spawn('bash', [script, '--jobs-dir', t.jobs, '--cap', '100', 'hangup', 'anthropic/claude-opus-5-5', 'fin-saccr-rwa'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: stubEnv(t, { ANTHROPIC_API_KEY: KEY, STUB_HANG: '1' })
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })))
    try {
      // Once Harbor is mid-job and the guard is polling, hang up the whole group, as the
      // kernel does when the terminal closes or an SSH session drops.
      await waitFor(() => existsSync(join(t.log, 'harbor-ready')) && existsSync(join(t.jobs, 'hangup.spend')), 'the job to start')
      process.kill(-child.pid, 'SIGHUP')
      expect(await exited).toEqual({ code: 143, signal: null })
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const logs = stubLogs(t)
    expect(stderr).toContain('interrupted; stopping hangup')
    expect(logs.harborSignals).toBe('TERM\n')
    expect(logs.docker).toContain('rm -f c1')
    expect(logs.docker).toContain('rm -f c2')
    expect(logs.docker).not.toContain('c3')
    expect(logs.docker).not.toContain('c4')
  }, 20_000)

  it('stops the job when it cannot read the spend three checks in a row', () => {
    const t = setup()
    const res = run(t, ['--cap', '100', 'blind', 'anthropic/claude-opus-5-5', 'fin-saccr-rwa'], { ANTHROPIC_API_KEY: KEY, STUB_HANG: '1' }, { kit: brokenGuardKit(t) })
    expect(res.status).toBe(3)
    expect(res.stderr.match(/the spend check failed/g)).toHaveLength(3)
    expect(res.stderr).toContain('spend unknown after 3 failed checks')
    expect(res.docker).toContain('rm -f c1')
  })

  it('dry-runs with a placeholder key, never the real one', () => {
    const t = setup()
    const res = run(t, ['--dry-run', 'dry', 'anthropic/claude-haiku-5-5', 'fin-saccr-rwa'], { ANTHROPIC_API_KEY: KEY, STUB_COST: '0' })
    expect(res.status).toBe(0)
    expect(res.key).toBe('houston-bench-dry-run-placeholder')
    expect(res.stderr).toContain('dry run')
  })

  it('refuses to start without the key, a cap, a known provider, or a fresh job name', () => {
    const t = setup()
    const refusals = [
      [['--cap', '5', 'j', 'anthropic/claude-opus-5-5'], {}, 'ANTHROPIC_API_KEY is not set'],
      [['--cap', '5', 'j', 'openai/gpt-6.1-sol'], { ANTHROPIC_API_KEY: KEY }, 'OPENAI_API_KEY is not set'],
      [['j', 'anthropic/claude-opus-5-5'], { ANTHROPIC_API_KEY: KEY }, 'needs --cap'],
      [['--cap', '0', 'j', 'anthropic/claude-opus-5-5'], { ANTHROPIC_API_KEY: KEY }, '--cap needs a dollar amount'],
      [['--cap', '5', 'j', 'mystery/model'], { ANTHROPIC_API_KEY: KEY }, 'provider anthropic, openai or gemini'],
      [['--cap', '5', 'j', 'anthropic/'], { ANTHROPIC_API_KEY: KEY }, 'must be provider/model'],
      [['--cap', '5', '../j', 'anthropic/claude-opus-5-5'], { ANTHROPIC_API_KEY: KEY }, 'job name may hold only'],
      [['--cap', '5', 'j', 'anthropic/claude-opus-5-5', 'bad task'], { ANTHROPIC_API_KEY: KEY }, 'not a task name'],
      [['--cap', '5', '--pkg', '/nonexistent/houston-code-cli-0.12.0.tgz', 'j', 'anthropic/claude-opus-5-5'], { ANTHROPIC_API_KEY: KEY }, 'no package at'],
      [['--cap', '5', '--label', 'x', 'j', 'anthropic/claude-opus-5-5'], { ANTHROPIC_API_KEY: KEY }, '--label goes with --pkg']
    ]
    for (const [args, env, message] of refusals) {
      const res = run(t, args, env)
      expect(res.status, message).toBe(2)
      expect(res.stderr).toContain(message)
      expect(res.argv, message).toBeNull()
    }

    mkdirSync(join(t.jobs, 'taken'), { recursive: true })
    const res = run(t, ['--cap', '5', 'taken', 'anthropic/claude-opus-5-5'], { ANTHROPIC_API_KEY: KEY })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('already exists')
    expect(res.argv).toBeNull()
  })
})
