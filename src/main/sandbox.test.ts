import { describe, expect, it } from 'vitest'
import { delimiter } from 'node:path'
import { augmentPath } from './sandbox'

describe('augmentPath', () => {
  const minimalPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)

  it('appends Homebrew and ~/.local/bin when they exist', () => {
    const out = augmentPath({ PATH: minimalPath, HOME: '/Users/me' }, () => true).split(delimiter)
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).toContain('/opt/homebrew/sbin')
    expect(out).toContain('/Users/me/.local/bin')
  })

  it('preserves inherited entries first and does not duplicate them', () => {
    const out = augmentPath({ PATH: minimalPath }, () => true).split(delimiter)
    expect(out.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(out.filter((d) => d === '/usr/bin')).toHaveLength(1) // /usr/bin is also a candidate
  })

  it('adds nothing when the extra dirs do not exist', () => {
    expect(augmentPath({ PATH: minimalPath }, () => false)).toBe(minimalPath)
  })

  it('builds a PATH from scratch when none is inherited', () => {
    const out = augmentPath({ HOME: '/Users/me' }, () => true).split(delimiter)
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).not.toContain('') // no empty segments
  })

  it('omits ~/.local/bin when HOME is unset', () => {
    const out = augmentPath({ PATH: '/usr/bin' }, () => true)
    expect(out).not.toMatch(/\.local\/bin/)
  })
})
