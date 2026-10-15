import { describe, it, expect } from 'vitest'
import { delimiter, join, resolve } from 'node:path'
import { chooseBinDir, pathHint, resolveTarget } from './install-cli.mjs'

// Host-native paths and PATH separator, so the expectations hold on Windows too.
const HOME = resolve('/home/dev')
const p = (...parts) => parts.join(delimiter)
const LOCAL_BIN = join(HOME, '.local', 'bin')

describe('resolveTarget', () => {
  it('expands a bare ~ to home', () => {
    expect(resolveTarget('~', HOME)).toBe(HOME)
  })

  it('expands a ~/ prefix', () => {
    expect(resolveTarget('~/bin', HOME)).toBe(join(HOME, 'bin'))
  })

  it('leaves an absolute path untouched', () => {
    expect(resolveTarget('/usr/local/bin', HOME)).toBe('/usr/local/bin')
  })

  it('does not treat a ~ mid-path as home', () => {
    expect(resolveTarget('/opt/~cache/bin', HOME)).toBe('/opt/~cache/bin')
  })
})

describe('chooseBinDir', () => {
  it('defaults to ~/.local/bin when nothing is on PATH', () => {
    const { dir, onPath } = chooseBinDir({ home: HOME, pathValue: p('/usr/bin', '/bin') })
    expect(dir).toBe(LOCAL_BIN)
    expect(onPath).toBe(false)
  })

  it('prefers ~/.local/bin when it is already on PATH', () => {
    const { dir, onPath } = chooseBinDir({
      home: HOME,
      pathValue: p(LOCAL_BIN, '/usr/bin')
    })
    expect(dir).toBe(LOCAL_BIN)
    expect(onPath).toBe(true)
  })

  it('always defaults to ~/.local/bin, even when another bin dir is on PATH', () => {
    // Deterministic: it no longer falls through to whichever candidate happens
    // to be on PATH (~/bin, /usr/local/bin). onPath reflects only ~/.local/bin.
    expect(chooseBinDir({ home: HOME, pathValue: p(join(HOME, 'bin'), '/usr/bin') })).toEqual({
      dir: LOCAL_BIN,
      onPath: false
    })
    expect(chooseBinDir({ home: HOME, pathValue: p('/usr/local/bin', '/usr/bin') })).toEqual({
      dir: LOCAL_BIN,
      onPath: false
    })
  })

  it('honours an explicit override and reports whether it is on PATH', () => {
    const onPath = chooseBinDir({
      home: HOME,
      pathValue: p('/opt/tools', '/usr/bin'),
      override: '/opt/tools'
    })
    expect(onPath).toEqual({ dir: '/opt/tools', onPath: true })

    const offPath = chooseBinDir({ home: HOME, pathValue: '/usr/bin', override: '~/tools' })
    expect(offPath).toEqual({ dir: join(HOME, 'tools'), onPath: false })
  })

  it('tolerates an empty PATH', () => {
    const { dir, onPath } = chooseBinDir({ home: HOME, pathValue: '' })
    expect(dir).toBe(LOCAL_BIN)
    expect(onPath).toBe(false)
  })
})

describe('pathHint', () => {
  it('produces a prepend-to-PATH export line', () => {
    expect(pathHint('/home/dev/.local/bin')).toBe('export PATH="/home/dev/.local/bin:$PATH"')
  })
})
