// Runs website/public/install.sh for real against a local file:// "release", so it never
// touches the network or the user's PATH. HOUSTON_DOWNLOAD_BASE and HOUSTON_INSTALL_DIR
// point it at a temp release folder and a temp bin dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SCRIPT = resolve(__dirname, '../website/public/install.sh')
const CLI = '#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("9.9.9")\n'
const sha = (s) => createHash('sha256').update(s).digest('hex')

let dir, release, bin

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-install-sh-'))
  release = join(dir, 'release')
  bin = join(dir, 'bin')
  mkdirSync(release)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function publish({ cli = CLI, sums = `${sha(CLI)}  houston-cli.cjs\n${'b'.repeat(64)}  other.dmg\n` } = {}) {
  writeFileSync(join(release, 'houston-cli.cjs'), cli)
  writeFileSync(join(release, 'SHA256SUMS'), sums)
}

function run(env = {}) {
  // An absolute sh, so a test can hand the script a PATH that has no sh on it.
  return spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOUSTON_DOWNLOAD_BASE: pathToFileURL(release).href,
      HOUSTON_INSTALL_DIR: bin,
      ...env,
    },
  })
}

// install.sh is a POSIX sh script for macOS and Linux; Windows users install another way.
describe.skipIf(process.platform === 'win32')('install.sh', () => {
  it('installs a verified CLI as an executable `houston`', () => {
    publish()
    const r = run()
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(readFileSync(join(bin, 'houston'), 'utf8')).toBe(CLI)
    expect(r.stdout).toContain(`Installed Houston CLI 9.9.9 to ${bin}/houston`)
  })

  it('tells the user when the install dir is not on PATH', () => {
    publish()
    expect(run().stdout).toContain(`export PATH="${bin}:$PATH"`)
  })

  it('stays quiet about PATH when the install dir is already on it', () => {
    publish()
    const r = run({ PATH: `${bin}:${process.env.PATH}` })
    expect(r.stdout).not.toContain('not on your PATH')
  })

  it('refuses a download that does not match SHA256SUMS and installs nothing', () => {
    publish({ sums: `${'c'.repeat(64)}  houston-cli.cjs\n` })
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('checksum mismatch')
    expect(existsSync(join(bin, 'houston'))).toBe(false)
  })

  it('refuses when SHA256SUMS does not list the CLI', () => {
    publish({ sums: `${sha(CLI)}  houston-cli.cjs.bak\n` })
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('no entry for houston-cli.cjs')
  })

  it('fails cleanly when the release has no CLI', () => {
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('download failed')
  })

  it('replaces an existing install', () => {
    publish()
    mkdirSync(bin)
    writeFileSync(join(bin, 'houston'), 'old')
    expect(run().status).toBe(0)
    expect(readFileSync(join(bin, 'houston'), 'utf8')).toBe(CLI)
  })

  it('refuses a Node older than 22', () => {
    publish()
    const stubs = join(dir, 'stubs')
    mkdirSync(stubs)
    writeFileSync(join(stubs, 'node'), '#!/bin/sh\ncase "$1" in -p) echo 18 ;; *) echo v18.20.0 ;; esac\n')
    chmodSync(join(stubs, 'node'), 0o755)
    const r = run({ PATH: `${stubs}:${process.env.PATH}` })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Node 22 or newer is required (found v18.20.0)')
    expect(existsSync(join(bin, 'houston'))).toBe(false)
  })

  it('rejects a malformed HOUSTON_VERSION before downloading anything', () => {
    const r = run({ HOUSTON_DOWNLOAD_BASE: '', HOUSTON_VERSION: '1.0; rm -rf ~' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('HOUSTON_VERSION must look like 0.3.0')
  })

  it('warns when another houston comes first on PATH', () => {
    publish()
    const other = join(dir, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'houston'), '#!/bin/sh\necho old\n')
    chmodSync(join(other, 'houston'), 0o755)
    const r = run({ PATH: `${other}:${bin}:${process.env.PATH}` })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`Another houston comes first on your PATH: ${other}/houston`)
    expect(r.stdout).not.toContain('Run: houston --help')
  })

  it('refuses to install over a directory named houston', () => {
    publish()
    mkdirSync(join(bin, 'houston'), { recursive: true })
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('is a directory')
    expect(existsSync(join(bin, 'houston', 'houston-cli.cjs'))).toBe(false)
  })

  it('stops before downloading when no hash tool is available', () => {
    publish()
    // A PATH with everything the script needs except sha256sum and shasum.
    const tools = join(dir, 'tools')
    mkdirSync(tools)
    for (const name of ['node', 'curl', 'awk', 'mktemp', 'rm', 'mkdir', 'cp', 'chmod', 'mv']) {
      const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
      if (found) symlinkSync(found, join(tools, name))
    }
    const r = run({ PATH: tools })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('sha256sum or shasum is required')
    expect(r.stderr).not.toContain('checksum mismatch')
    expect(r.stdout).not.toContain('Downloading')
  })

  it('never prints an em dash to the user', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('—')
  })
})
