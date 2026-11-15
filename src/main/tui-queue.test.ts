import { describe, expect, it } from 'vitest'
import { parseQueueArgs, renderQueueList } from './tui-queue'

describe('parseQueueArgs', () => {
  it('lists with no argument, and reads drop, send and clear', () => {
    expect(parseQueueArgs('')).toEqual({ op: 'list' })
    expect(parseQueueArgs(' drop 2 ')).toEqual({ op: 'drop', index: 2 })
    expect(parseQueueArgs('rm 1')).toEqual({ op: 'drop', index: 1 })
    expect(parseQueueArgs('send 3')).toEqual({ op: 'send', index: 3 })
    expect(parseQueueArgs('clear')).toEqual({ op: 'clear' })
  })

  it('says how to use it for anything else', () => {
    expect(parseQueueArgs('drop')).toEqual({ op: 'usage' })
    expect(parseQueueArgs('drop 0')).toEqual({ op: 'usage' })
    expect(parseQueueArgs('drop x')).toEqual({ op: 'usage' })
    expect(parseQueueArgs('send 1 2')).toEqual({ op: 'usage' })
    expect(parseQueueArgs('nonsense')).toEqual({ op: 'usage' })
  })
})

describe('renderQueueList', () => {
  it('numbers the waiting messages oldest first, with the keys that act on them', () => {
    expect(renderQueueList(['run the tests', '/compact'])).toEqual([
      'Queued for after this turn (2):',
      '  1. run the tests',
      '  2. /compact',
      'Up edits the newest, /queue drop <n> removes one, /queue send <n> sends one to the turn now.'
    ])
    expect(renderQueueList([])).toEqual(['Nothing is queued.'])
  })

  it('keeps each on one line, with no control characters, and caps a long one', () => {
    const [, row] = renderQueueList(['a\x1b[31m\nb'])
    expect(row).toBe('  1. a[31m b')
    const [, long] = renderQueueList(['x'.repeat(300)])
    expect(long.length).toBeLessThan(210)
    expect(long.endsWith('…')).toBe(true)
  })
})
