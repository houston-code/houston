import { describe, it, expect } from 'vitest'
import { statusText } from './statusLine'
import type { DisplayItem } from './items'

const tool = (status: DisplayItem extends { kind: 'tool' } ? never : string): DisplayItem =>
  ({ kind: 'tool', id: 'c', name: 'edit_file', status } as unknown as DisplayItem)

describe('statusText', () => {
  it('is Ready when not running', () => {
    expect(statusText([], false)).toBe('Ready')
  })

  it('reports a running tool', () => {
    expect(statusText([tool('running')], true)).toBe('Running edit_file')
  })

  it('reports awaiting approval', () => {
    expect(statusText([tool('awaiting-approval')], true)).toBe('Awaiting approval — edit_file')
  })

  it('reports responding while the assistant streams', () => {
    const item = { kind: 'assistant', id: 'a', text: 'hi', streaming: true } as DisplayItem
    expect(statusText([item], true)).toBe('Responding…')
  })

  it('falls back to Working… otherwise', () => {
    const item = { kind: 'user', id: 'u', text: 'go' } as DisplayItem
    expect(statusText([item], true)).toBe('Working…')
  })
})
