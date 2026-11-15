import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { ShellOutputHold, type HeldShellRun, type RecordShellAnswer } from './shellOutputHold'

const run = (conversationId: string, command: string): HeldShellRun => ({
  conversationId,
  command,
  output: `${command} output`,
  exitCode: 0
})
const msgs = (text: string): ChatMessage[] => [{ role: 'user', content: text }]

describe('ShellOutputHold', () => {
  it("adds each held output once its chat's turn has ended, oldest first, exactly once", async () => {
    const hold = new ShellOutputHold()
    hold.hold(run('a', 'npm test'))
    hold.hold(run('a', 'git status'))
    const record = vi.fn(async (r: HeldShellRun): Promise<RecordShellAnswer> => ({ ok: true, messages: msgs(r.command) }))

    // Still running: nothing is added, everything waits.
    expect((await hold.flush(() => true, record)).size).toBe(0)
    expect(record).not.toHaveBeenCalled()
    expect(hold.has('a')).toBe(true)

    const added = await hold.flush(() => false, record)
    expect(record.mock.calls.map(([r]) => r.command)).toEqual(['npm test', 'git status'])
    expect(added.get('a')).toEqual(msgs('git status'))
    expect(hold.has()).toBe(false)

    await hold.flush(() => false, record)
    expect(record).toHaveBeenCalledTimes(2)
  })

  it('keeps one refused as busy, and the ones after it in that chat, without blocking other chats', async () => {
    const hold = new ShellOutputHold()
    hold.hold(run('a', 'first'))
    hold.hold(run('b', 'other'))
    hold.hold(run('a', 'second'))
    const record = vi.fn(async (r: HeldShellRun): Promise<RecordShellAnswer> =>
      r.conversationId === 'a' ? { ok: false, reason: 'busy' } : { ok: true, messages: msgs(r.command) }
    )
    const added = await hold.flush(() => false, record)
    expect([...added.keys()]).toEqual(['b'])
    // `second` was never tried: it must not land before `first`.
    expect(record.mock.calls.map(([r]) => r.command)).toEqual(['first', 'other'])
    expect(hold.has('a')).toBe(true)
    expect(hold.has('b')).toBe(false)
    expect(hold.ids()).toEqual(['a'])
  })

  it('drops one whose chat is gone, and treats a failed call as busy', async () => {
    const hold = new ShellOutputHold()
    hold.hold(run('gone', 'x'))
    hold.hold(run('flaky', 'y'))
    await hold.flush(
      () => false,
      async (r) => {
        if (r.conversationId === 'flaky') throw new Error('ipc')
        return { ok: false, reason: 'missing' }
      }
    )
    expect(hold.has('gone')).toBe(false)
    expect(hold.has('flaky')).toBe(true)
  })

  it('keeps what is held during a flush, and ignores a second flush while one runs', async () => {
    const hold = new ShellOutputHold()
    hold.hold(run('a', 'first'))
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const record = vi.fn(async (r: HeldShellRun): Promise<RecordShellAnswer> => {
      if (r.command === 'first') await gate
      return { ok: true, messages: msgs(r.command) }
    })
    const one = hold.flush(() => false, record)
    hold.hold(run('a', 'late'))
    expect((await hold.flush(() => false, record)).size).toBe(0)
    release()
    await one
    expect(record.mock.calls.map(([r]) => r.command)).toEqual(['first'])
    expect(hold.has('a')).toBe(true)
    await hold.flush(() => false, record)
    expect(record.mock.calls.map(([r]) => r.command)).toEqual(['first', 'late'])
  })
})
