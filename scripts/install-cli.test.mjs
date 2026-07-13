import { describe, it, expect } from 'vitest'
import { chooseBinDir, pathHint, resolveTarget } from './install-cli.mjs'

const HOME = '/home/dev'

describe('resolveTarget', () => {
  it('expands a bare ~ to home', () => {
    expect(resolveTarget('~', HOME)).toBe(HOME)
  })

  it('expands a ~/ prefix', () => {
    expect(resolveTarget('~/bin', HOME)).toBe('/home/dev/bin')
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
    const { dir, onPath } = chooseBinDir({ home: HOME, pathValue: '/usr/bin:/bin' })
    expect(dir).toBe('/home/dev/.local/bin')
    expect(onPath).toBe(false)
  })

  it('prefers ~/.local/bin when it is already on PATH', () => {
    const { dir, onPath } = chooseBinDir({
      home: HOME,
      pathValue: '/home/dev/.local/bin:/usr/bin'
    })
    expect(dir).toBe('/home/dev/.local/bin')
    expect(onPath).toBe(true)
  })

  it('falls through to ~/bin when only that candidate is on PATH', () => {
    const { dir, onPath } = chooseBinDir({ home: HOME, pathValue: '/home/dev/bin:/usr/bin' })
    expect(dir).toBe('/home/dev/bin')
    expect(onPath).toBe(true)
  })

  it('uses /usr/local/bin when it is the only candidate on PATH', () => {
    const { dir, onPath } = chooseBinDir({ home: HOME, pathValue: '/usr/local/bin:/usr/bin' })
    expect(dir).toBe('/usr/local/bin')
    expect(onPath).toBe(true)
  })

  it('honours an explicit override and reports whether it is on PATH', () => {
    const onPath = chooseBinDir({
      home: HOME,
      pathValue: '/opt/tools:/usr/bin',
      override: '/opt/tools'
    })
    expect(onPath).toEqual({ dir: '/opt/tools', onPath: true })

    const offPath = chooseBinDir({ home: HOME, pathValue: '/usr/bin', override: '~/tools' })
    expect(offPath).toEqual({ dir: '/home/dev/tools', onPath: false })
  })

  it('tolerates an empty PATH', () => {
    const { dir, onPath } = chooseBinDir({ home: HOME, pathValue: '' })
    expect(dir).toBe('/home/dev/.local/bin')
    expect(onPath).toBe(false)
  })
})

describe('pathHint', () => {
  it('produces a prepend-to-PATH export line', () => {
    expect(pathHint('/home/dev/.local/bin')).toBe('export PATH="/home/dev/.local/bin:$PATH"')
  })
})
