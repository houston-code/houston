import { describe, expect, it } from 'vitest'
import { ACP_MAX_FRAME_BYTES, compactDiffTexts, fitAcpFrame } from './acpFrame'

const size = (line: string): number => Buffer.byteLength(line, 'utf8') + 1
const lines = (n: number, tag = 'row'): string[] => Array.from({ length: n }, (_, i) => `${tag} ${i} ${'y'.repeat(40)}`)

const toolUpdate = (u: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', ...u } }
})

describe('compactDiffTexts', () => {
  it('keeps the changed lines with context and folds the rest on both sides', () => {
    const a = lines(100)
    const b = [...a]
    b[50] = 'NEW'
    const d = compactDiffTexts(a.join('\n'), b.join('\n'))
    expect(d.oldText.split('\n')).toEqual(['⋯ 47 unchanged lines', ...a.slice(47, 54), '⋯ 46 unchanged lines'])
    expect(d.newText.split('\n')).toEqual(['⋯ 47 unchanged lines', ...a.slice(47, 50), 'NEW', ...a.slice(51, 54), '⋯ 46 unchanged lines'])
  })

  it('handles insertions at either end and identical texts without negative ranges', () => {
    expect(compactDiffTexts('a\nb', 'x\na\nb')).toEqual({ oldText: 'a\nb', newText: 'x\na\nb' })
    expect(compactDiffTexts('a\nb', 'a\nb\nz')).toEqual({ oldText: 'a\nb', newText: 'a\nb\nz' })
    const same = lines(20).join('\n')
    const d = compactDiffTexts(same, same)
    expect(d.oldText).toBe(d.newText)
    expect(d.oldText.split('\n').length).toBeLessThanOrEqual(7)
  })

  it('says "line" for a run of one', () => {
    const a = ['k', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const b = [...a]
    b[4] = 'D'
    expect(compactDiffTexts(a.join('\n'), b.join('\n')).oldText.split('\n')[0]).toBe('⋯ 1 unchanged line')
  })
})

describe('fitAcpFrame', () => {
  it('sends a frame that fits exactly as JSON.stringify would', () => {
    const m = toolUpdate({ content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })
    expect(fitAcpFrame(m)).toBe(JSON.stringify(m))
  })

  it('never touches other methods or responses, however big', () => {
    const m = { jsonrpc: '2.0', id: 3, result: { text: 'z'.repeat(100_000) } }
    expect(fitAcpFrame(m)).toBe(JSON.stringify(m))
  })

  it('replaces an oversized image first and keeps the rest whole', () => {
    const m = toolUpdate({
      content: [
        { type: 'content', content: { type: 'text', text: 'shot taken' } },
        { type: 'content', content: { type: 'image', data: 'Q'.repeat(90_000), mimeType: 'image/png' } }
      ]
    })
    const out = JSON.parse(fitAcpFrame(m))
    expect(out.params.update.content[0]).toEqual({ type: 'content', content: { type: 'text', text: 'shot taken' } })
    expect(out.params.update.content[1].content).toEqual({
      type: 'text',
      text: '[image (image/png) not shown: too large for one message]'
    })
  })

  it('compacts a whole-file diff to the change before shortening anything else', () => {
    const a = lines(3000)
    const b = [...a]
    b[1500] = 'EDITED'
    const m = toolUpdate({ content: [{ type: 'diff', path: '/w/f.ts', oldText: a.join('\n'), newText: b.join('\n') }] })
    const line = fitAcpFrame(m)
    expect(size(line)).toBeLessThanOrEqual(ACP_MAX_FRAME_BYTES)
    const d = JSON.parse(line).params.update.content[0]
    expect(d.path).toBe('/w/f.ts')
    expect(d.newText).toContain('EDITED')
    expect(d.oldText).toContain(a[1500])
  })

  it('shortens raw input strings (a write_file body) and keeps their keys', () => {
    const m = toolUpdate({ rawInput: { path: 'big.txt', content: 'c'.repeat(80_000) } })
    const out = JSON.parse(fitAcpFrame(m)).params.update
    expect(out.rawInput.path).toBe('big.txt')
    expect(out.rawInput.content.length).toBeLessThan(3_000)
    expect(out.rawInput.content).toContain('shortened to fit one message')
  })

  it('shortens long text output when nothing else is left to cut', () => {
    const m = toolUpdate({ content: [{ type: 'content', content: { type: 'text', text: '日本'.repeat(40_000) } }] })
    const line = fitAcpFrame(m)
    expect(size(line)).toBeLessThanOrEqual(ACP_MAX_FRAME_BYTES)
    expect(JSON.parse(line).params.update.content[0].content.text).toContain('shortened to fit one message')
  })

  it('falls back to one note when many blocks together are still too big', () => {
    const many = Array.from({ length: 2000 }, () => ({ type: 'content', content: { type: 'text', text: 'w'.repeat(300) } }))
    const line = fitAcpFrame(toolUpdate({ content: many, rawInput: { a: 'b' } }))
    expect(size(line)).toBeLessThanOrEqual(ACP_MAX_FRAME_BYTES)
    const u = JSON.parse(line).params.update
    expect(u.content).toEqual([{ type: 'content', content: { type: 'text', text: '[output not shown: too large for one message]' } }])
    expect(u.rawInput).toBeUndefined()
    expect(u.toolCallId).toBe('c1')
  })

  it('fits a permission request carrying a big preview and leaves the caller object unchanged', () => {
    const toolCall = { toolCallId: 'p', content: [{ type: 'diff', path: '/w/n.txt', oldText: null, newText: 'n'.repeat(90_000) }] }
    const m = { jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { sessionId: 's', toolCall, options: [] } }
    const before = JSON.stringify(m)
    const line = fitAcpFrame(m)
    expect(size(line)).toBeLessThanOrEqual(ACP_MAX_FRAME_BYTES)
    expect(JSON.parse(line).params.options).toEqual([])
    expect(JSON.stringify(m)).toBe(before)
  })

  it('shrinks a single-block message chunk (a replayed pasted image)', () => {
    const m = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'user_message_chunk', content: { type: 'image', data: 'I'.repeat(90_000), mimeType: 'image/jpeg' } } }
    }
    const u = JSON.parse(fitAcpFrame(m)).params.update
    expect(u.content).toEqual({ type: 'text', text: '[image (image/jpeg) not shown: too large for one message]' })
  })
})
