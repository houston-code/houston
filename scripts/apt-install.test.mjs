import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'apt-install.sh')
const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * Runs apt-install.sh against stubbed `sudo`, `timeout`, `dpkg-query` and `apt-get`, which
 * come first on PATH so nothing real is ever installed.
 *   installed:       packages dpkg-query reports as already installed
 *   updateFailures:  how many `apt-get update` calls fail (exit 100) before one passes
 *   installFailures: the same for `apt-get install`
 *   realTimeout:     use the system `timeout` instead of the pass-through stub
 *   hangUpdate:      make `apt-get update` sleep far past the limit
 */
function run(packages, opts = {}) {
  const { installed = [], updateFailures = 0, installFailures = 0, realTimeout = false, hangUpdate = false, env = {} } = opts
  const dir = mkdtempSync(join(tmpdir(), 'apt-install-'))
  dirs.push(dir)
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  stub('sudo', 'exec "$@"')
  if (!realTimeout) stub('timeout', 'echo "timeout $1 $2 $3" >> "$STUB_DIR/timeout.log"; shift 3; exec "$@"')
  stub('dpkg-query', 'pkg="${@: -1}"; case " $STUB_INSTALLED " in *" $pkg "*) printf installed ;; *) exit 1 ;; esac')
  stub(
    'apt-get',
    [
      'echo "$*" >> "$STUB_DIR/apt.log"',
      'verb=; for a in "$@"; do case "$a" in update|install) verb=$a ;; esac; done',
      'n=$(($(cat "$STUB_DIR/$verb.count" 2>/dev/null || echo 0) + 1)); echo "$n" > "$STUB_DIR/$verb.count"',
      'if [ "$verb" = update ] && [ -n "$STUB_HANG_UPDATE" ]; then exec sleep 60; fi',
      'limit=$STUB_UPDATE_FAILURES; [ "$verb" = install ] && limit=$STUB_INSTALL_FAILURES',
      '[ "$n" -gt "$limit" ] || exit 100'
    ].join('\n')
  )
  const res = spawnSync('bash', [script, ...packages], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${SYSTEM_PATH}`,
      STUB_DIR: dir,
      STUB_INSTALLED: installed.join(' '),
      STUB_UPDATE_FAILURES: String(updateFailures),
      STUB_INSTALL_FAILURES: String(installFailures),
      STUB_HANG_UPDATE: hangUpdate ? '1' : '',
      APT_RETRY_DELAY: '0',
      ...env
    }
  })
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
  const count = (f) => Number(read(f) || 0)
  return { ...res, apt: read('apt.log'), timeouts: read('timeout.log'), updates: count('update.count'), installs: count('install.count') }
}

// GNU timeout is on every Linux runner; a macOS machine has it only via Homebrew coreutils.
const SYSTEM_PATH = '/usr/bin:/bin:/opt/homebrew/bin'
const hasTimeout = spawnSync('bash', ['-c', 'command -v timeout'], { env: { PATH: SYSTEM_PATH } }).status === 0

describe.skipIf(process.platform === 'win32')('apt-install.sh', () => {
  it('skips apt entirely when every package is already installed', () => {
    const res = run(['bubblewrap', 'xvfb'], { installed: ['bubblewrap', 'xvfb'] })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Already installed: bubblewrap xvfb')
    expect(res.apt).toBe('')
  })

  it('installs only the missing packages, with connection timeouts and a wall-clock limit', () => {
    const res = run(['xvfb', 'bubblewrap'], { installed: ['xvfb'] })
    expect(res.status).toBe(0)
    expect(res.updates).toBe(1)
    expect(res.installs).toBe(1)
    const install = res.apt.split('\n').find((l) => l.includes(' install '))
    expect(install).toMatch(/ install -y bubblewrap$/)
    for (const line of res.apt.trim().split('\n')) {
      expect(line).toContain('Acquire::http::Timeout=20')
      expect(line).toContain('Acquire::https::Timeout=20')
      expect(line).toContain('Acquire::Retries=2')
    }
    // Both apt calls ran under `timeout -k 10 75`.
    expect(res.timeouts.trim().split('\n')).toEqual(['timeout -k 10 75', 'timeout -k 10 75'])
  })

  it('still installs when apt-get update fails, and says so', () => {
    const res = run(['bubblewrap'], { updateFailures: 99 })
    expect(res.status).toBe(0)
    expect(res.installs).toBe(1)
    expect(res.stdout).toContain('::warning::apt-get update failed or timed out (exit 100)')
  })

  it('retries a failed install, refreshing the package lists each time', () => {
    const res = run(['bubblewrap'], { installFailures: 2 })
    expect(res.status).toBe(0)
    expect(res.installs).toBe(3)
    expect(res.updates).toBe(3)
    expect(res.stdout).toContain('failed (exit 100, attempt 2 of 3); retrying in 0s')
  })

  it("gives up after the last attempt with apt's exit status", () => {
    const res = run(['bubblewrap'], { installFailures: 99, env: { APT_ATTEMPTS: '2' } })
    expect(res.status).toBe(100)
    expect(res.installs).toBe(2)
    expect(res.stdout).toContain('::error::apt-get install bubblewrap failed 2 times (last exit 100)')
  })

  it.skipIf(!hasTimeout)('cuts off an apt-get update that hangs and carries on to the install', () => {
    const started = Date.now()
    const res = run(['bubblewrap'], { realTimeout: true, hangUpdate: true, env: { APT_TIMEOUT: '1' } })
    expect(res.status).toBe(0)
    expect(res.installs).toBe(1)
    expect(res.stdout).toContain('::warning::apt-get update failed or timed out (exit 124)')
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  it('refuses to run with no packages', () => {
    const res = spawnSync('bash', [script], { encoding: 'utf8' })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('usage: apt-install.sh')
  })
})
