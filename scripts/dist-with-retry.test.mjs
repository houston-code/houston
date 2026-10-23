import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'dist-with-retry.sh')
const FLAKE = 'dmgbuild.core.DMGError: Unable to detach device cleanly: hdiutil: couldn\'t eject "disk2" - Resource busy'
// The staple flake from a v0.9.0 publish (darwin-x64), trimmed to the lines that matter.
const STAPLE_FLAKE = [
  'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
  "CloudKit's response is inconsistent with expections: (null)",
  'The staple and validate action failed! Error 68.'
].join('\n')

// Stub `npm` fails its first $FAILS calls with $MSG; stub `hdiutil` lists one simulator
// runtime image and one image from the workspace, and records every other call.
const NPM = `#!/bin/bash
n=$(cat "$STUB_DIR/npm-calls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/npm-calls"
echo "npm $*" >> "$STUB_DIR/npm-args"
if [ "$n" -le "$FAILS" ]; then echo "$MSG"; exit 1; fi
`
const HDIUTIL = `#!/bin/bash
if [ "$1" = info ]; then cat <<EOF
framework       : 671.100.2
================================================
image-path      : /Library/Developer/CoreSimulator/Images/runtime.dmg
image-type      : read-only
/dev/disk3	GUID_partition_scheme
/dev/disk3s1	Apple_APFS
================================================
image-path      : $GITHUB_WORKSPACE/release/.tempabcHouston-0.8.0-x64.dmg
image-type      : read/write
/dev/disk2	GUID_partition_scheme
/dev/disk2s1	Apple_HFS	/Volumes/Houston
EOF
else echo "$*" >> "$STUB_DIR/hdiutil-calls"; fi
`

// Bash stubs on PATH don't resolve the same way under Git Bash, and the retry only ever
// fires on macOS, so the Windows leg skips this.
describe.skipIf(process.platform === 'win32')('dist-with-retry.sh', () => {
  let dir
  // The stubs are written once, and each is run once here. macOS scans an executable the
  // first time it runs (about half a second each, and the scans queue under a loaded
  // machine), so writing fresh stubs for every test put that cost inside every test and
  // timed some out during a full suite run. Each run() clears what the stubs record.
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dist-retry-'))
    for (const [name, body] of [['npm', NPM], ['hdiutil', HDIUTIL]]) {
      writeFileSync(join(dir, name), body)
      chmodSync(join(dir, name), 0o755)
      spawnSync(join(dir, name), ['info'], { env: { STUB_DIR: dir, FAILS: '0', MSG: '', GITHUB_WORKSPACE: '/ws' } })
    }
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = ({ os = 'macOS', fails = 0, msg = FLAKE, args = ['dist:mac:x64'] } = {}) => {
    for (const f of ['npm-calls', 'npm-args', 'hdiutil-calls']) rmSync(join(dir, f), { force: true })
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        STUB_DIR: dir,
        RUNNER_OS: os,
        RUNNER_TEMP: dir,
        GITHUB_WORKSPACE: '/ws',
        DIST_RETRY_DELAY: '0',
        FAILS: String(fails),
        MSG: msg
      }
    })
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      attempts: Number(read('npm-calls') || 0),
      npmArgs: read('npm-args').trim().split('\n')[0],
      hdiutil: read('hdiutil-calls').trim().split('\n').filter(Boolean)
    }
  }

  it('runs the dist script once, with --publish never, when it succeeds', () => {
    const r = run()
    expect(r).toMatchObject({ status: 0, attempts: 1, hdiutil: [] })
    expect(r.npmArgs).toBe('npm run dist:mac:x64 -- --publish never')
  })

  it('retries the detach flake on macOS and force-detaches only the workspace image', () => {
    const r = run({ fails: 2 })
    expect(r).toMatchObject({ status: 0, attempts: 3 })
    expect(r.hdiutil).toEqual(['detach -force /dev/disk2', 'detach -force /dev/disk2'])
    expect(r.out).toContain('::warning::dmg detach flake')
  })

  it('gives up after three attempts', () => {
    expect(run({ fails: 3 })).toMatchObject({ status: 1, attempts: 3 })
  })

  it('retries a stapling network failure on macOS without touching disk images', () => {
    const r = run({ fails: 2, msg: STAPLE_FLAKE })
    expect(r).toMatchObject({ status: 0, attempts: 3, hdiutil: [] })
    expect(r.out).toContain('::warning::stapling lost its connection to Apple on attempt 2 of 3, retrying')
  })

  it('gives up on stapling after three attempts', () => {
    expect(run({ fails: 3, msg: STAPLE_FLAKE })).toMatchObject({ status: 1, attempts: 3 })
  })

  it('does not retry a stapling failure that is not a network error', () => {
    const msg = 'The staple and validate action failed! Error 65.'
    expect(run({ fails: 1, msg })).toMatchObject({ status: 1, attempts: 1 })
    // Error 68 alone, without the lost connection, is not enough either.
    expect(run({ fails: 1, msg: 'The staple and validate action failed! Error 68.' })).toMatchObject({
      status: 1,
      attempts: 1
    })
  })

  it('does not retry a stapling failure off macOS', () => {
    expect(run({ os: 'Linux', fails: 1, msg: STAPLE_FLAKE })).toMatchObject({ status: 1, attempts: 1 })
  })

  it('does not retry any other failure', () => {
    expect(run({ fails: 1, msg: 'Error: not a file' })).toMatchObject({ status: 1, attempts: 1, hdiutil: [] })
  })

  it('does not retry off macOS, even on the same message', () => {
    for (const os of ['Linux', 'Windows']) {
      expect(run({ os, fails: 1 })).toMatchObject({ status: 1, attempts: 1, hdiutil: [] })
    }
  })

  it('requires a dist script name', () => {
    expect(run({ args: [] }).status).not.toBe(0)
  })
})
