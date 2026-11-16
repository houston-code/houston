import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { localEntry, main, releaseEntry } from './agent-entry.mjs'

const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), 'agent.json')
const template = () => JSON.parse(readFileSync(templatePath, 'utf8'))
const FLAGS = ['--acp', '--unattended', '--full-auto', '--effort', 'high', '--max-turns', '400']

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function capture() {
  const out = { text: '', write: (s) => (out.text += s) }
  return out
}

describe('agent.json', () => {
  it('launches the published CLI over ACP, unattended, in full auto with a step cap', () => {
    const entry = template()
    expect(entry.id).toBe('houston')
    expect(entry.distribution).toEqual({ npx: { package: '@houston-code/cli@latest', args: FLAGS } })
  })
})

describe('releaseEntry', () => {
  it('pins the package and the entry to one release, keeping the flags', () => {
    const original = template()
    const entry = releaseEntry(original, '0.12.1')
    expect(entry.version).toBe('0.12.1')
    expect(entry.distribution.npx).toEqual({ package: '@houston-code/cli@0.12.1', args: FLAGS })
    expect(original).toEqual(template())
  })

  it('refuses something that is not a version', () => {
    for (const v of ['latest', '0.12', 'v0.12.1', '0.12.1 && rm -rf /']) {
      expect(() => releaseEntry(template(), v)).toThrow(/--release needs a version/)
    }
    expect(releaseEntry(template(), '0.13.0-rc.1').version).toBe('0.13.0-rc.1')
  })
})

describe('localEntry', () => {
  it('runs the mounted tarball through npx, with houston as the command', () => {
    const original = template()
    const entry = localEntry(original, 'houston-code-cli-0.12.0.tgz', 'main.f49a4a7b')
    expect(entry.version).toBe('0.12.0+main.f49a4a7b')
    expect(entry.description).toContain('local build main.f49a4a7b')
    expect(entry.distribution.npx).toEqual({
      package: '--package=/opt/houston-pkg/houston-code-cli-0.12.0.tgz',
      args: ['houston', ...FLAGS]
    })
    expect(original).toEqual(template())
    expect(localEntry(original, 'houston-code-cli-0.12.0.tgz').version).toBe('0.12.0+local')
  })

  it('refuses a file that is not a packed CLI, and a label that cannot be a build tag', () => {
    for (const name of ['houston-cli.cjs', 'houston-code-cli.tgz', 'other-0.12.0.tgz', 'houston-code-cli-0.12.0.tar.gz']) {
      expect(() => localEntry(template(), name)).toThrow(/--pkg needs/)
    }
    for (const label of ['', 'has space', 'a+b', '-lead', 'x/y']) {
      expect(() => localEntry(template(), 'houston-code-cli-0.12.0.tgz', label)).toThrow(/--label/)
    }
  })
})

describe('agent-entry.mjs', () => {
  it('prints the template as written, or pinned, or pointed at a tarball', () => {
    const plain = capture()
    expect(main([templatePath], plain, capture())).toBe(0)
    expect(JSON.parse(plain.text)).toEqual(template())

    const local = capture()
    expect(main([templatePath, '--pkg', join('some', 'dir', 'houston-code-cli-0.12.0.tgz'), '--label', 'pr880'], local, capture())).toBe(0)
    expect(JSON.parse(local.text).distribution.npx.package).toBe('--package=/opt/houston-pkg/houston-code-cli-0.12.0.tgz')
  })

  it('refuses conflicting or incomplete arguments and a template with no npx entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-entry-'))
    dirs.push(dir)
    const bare = join(dir, 'bare.json')
    writeFileSync(bare, JSON.stringify({ id: 'houston', distribution: { binary: {} } }))
    const cases = [
      [],
      [templatePath, '--release'],
      [templatePath, '--release', '0.12.1', '--pkg', 'houston-code-cli-0.12.0.tgz'],
      [templatePath, '--label', 'x'],
      [templatePath, '--bogus'],
      [join(dir, 'missing.json')],
      [bare]
    ]
    for (const argv of cases) {
      const err = capture()
      expect(main(argv, capture(), err)).toBe(2)
      expect(err.text).toContain('usage: agent-entry.mjs')
    }
  })
})
