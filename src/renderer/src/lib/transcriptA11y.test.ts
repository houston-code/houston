import { describe, expect, it } from 'vitest'
import type { ToolItem } from './items'
import type { RenderNode } from './toolDisplay'
import { MAX_SPOKEN_CHARS, liveAnnouncement, messageHeading, spokenText } from './transcriptA11y'

const reply = (text: string, streaming = false): RenderNode => ({
  kind: 'assistant',
  id: 'a',
  item: { kind: 'assistant', id: 'a', text, streaming }
})
const tools = (...items: Partial<ToolItem>[]): RenderNode => ({
  kind: 'toolgroup',
  id: 'g',
  items: items.map((t, i) => ({ kind: 'tool', id: `t${i}`, name: 'read_file', status: 'done', ...t }) as ToolItem)
})

describe('messageHeading', () => {
  it('names who wrote a message, with the time for a reply when known', () => {
    expect(messageHeading('user', '2026-11-14T15:42:00')).toBe('You')
    expect(messageHeading('assistant', undefined)).toBe('Houston')
    expect(messageHeading('assistant', 'not a date')).toBe('Houston')
    const at = '2026-11-14T15:42:00'
    const time = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    expect(messageHeading('assistant', at)).toBe(`Houston, ${time}`)
  })
})

describe('spokenText', () => {
  it('reads markdown as prose: no fences, marks, markers, or link targets', () => {
    expect(spokenText('# Done\n\n- **Fixed** the `parse` bug, see [the PR](https://x.test/1)\n\n```ts\nconst a = 1\n```')).toBe(
      'Done Fixed the parse bug, see the PR const a = 1'
    )
  })

  it('caps a long reply', () => {
    const out = spokenText('word '.repeat(1000))
    expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('liveAnnouncement', () => {
  it('keeps to coarse states by default', () => {
    expect(liveAnnouncement(undefined, false)).toBe('')
    expect(liveAnnouncement(reply('hi', true), false)).toBe('The agent is responding…')
    expect(liveAnnouncement(reply('All **done**.'), false)).toBe('Response ready.')
    expect(liveAnnouncement(tools({ status: 'error', name: 'run_command' }), false)).toBe('')
  })

  it('reads a finished reply, and names failed tools, when opted in', () => {
    expect(liveAnnouncement(reply('All **done**.'), true)).toBe('Houston replied: All done.')
    // Still nothing to read while it streams, and an empty reply is just "ready".
    expect(liveAnnouncement(reply('All', true), true)).toBe('The agent is responding…')
    expect(liveAnnouncement(reply(''), true)).toBe('Response ready.')
    expect(
      liveAnnouncement(
        tools({ status: 'error', name: 'run_command' }, { status: 'done' }, { status: 'error', name: 'run_command' }),
        true
      )
    ).toBe('run_command failed.')
    expect(liveAnnouncement(tools({ status: 'done' }), true)).toBe('')
  })

  it('puts a waiting approval first either way', () => {
    const node = tools({ status: 'error', name: 'run_command' }, { status: 'awaiting-approval' })
    expect(liveAnnouncement(node, true)).toBe('The agent is waiting for your approval.')
    expect(liveAnnouncement(node, false)).toBe('The agent is waiting for your approval.')
  })
})
