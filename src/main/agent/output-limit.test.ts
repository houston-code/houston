import { describe, expect, it } from 'vitest'
import {
  MAX_OUTPUT_CONTINUATIONS,
  continuationNote,
  continuationNotice,
  incompleteCallResult,
  incompleteCallsNotice,
  raisedOutputCap
} from './output-limit'

describe('output-limit recovery text', () => {
  it('tells the model to split work the limit cut off', () => {
    const text = incompleteCallResult({ name: 'write_file' }, true)
    expect(text).toMatch(/^Not run:/)
    expect(text).toContain('write_file')
    expect(text).toContain('output limit')
    expect(text).toMatch(/edit_file or apply_patch/)
  })

  it('asks for valid JSON when the call was malformed rather than cut off', () => {
    const text = incompleteCallResult({ name: 'read_file' }, false)
    expect(text).toMatch(/^Not run:/)
    expect(text).toContain('not valid JSON')
    expect(text).not.toContain('output limit')
  })

  it('asks a cut-off reply to resume without a recap, or to answer when nothing was written', () => {
    expect(continuationNote(true)).toMatch(/Continue exactly where it stopped/)
    expect(continuationNote(true)).toMatch(/Do not repeat or recap/)
    expect(continuationNote(false)).toMatch(/before it produced any answer/)
  })

  it('names the continuation attempt and the calls in the user-facing notices', () => {
    expect(continuationNotice(2)).toContain(`(2/${MAX_OUTPUT_CONTINUATIONS})`)
    expect(incompleteCallsNotice([{ name: 'write_file' }])).toContain('a write_file call')
    expect(incompleteCallsNotice([{ name: 'write_file' }, { name: 'run_shell' }, { name: 'write_file' }])).toContain(
      'calls to write_file, run_shell'
    )
  })

  it('strips anything but tool-name characters from the names it shows', () => {
    const notice = incompleteCallsNotice([{ name: 'write_file\u001b]0;pwned\u0007' }])
    expect(notice).toContain('a write_file0pwned call')
    expect([...notice].some((ch) => ch.charCodeAt(0) < 0x20)).toBe(false)
    expect(incompleteCallsNotice([{ name: '\u001b[2J' }])).toContain('a 2J call')
    expect(incompleteCallsNotice([{ name: '\u0007' }])).toContain('a tool call')
  })

  it('keeps em dashes out of the user-facing notices', () => {
    for (const text of [continuationNotice(1), incompleteCallsNotice([{ name: 'write_file' }])]) {
      expect(text).not.toContain('—')
    }
  })
})

describe('raisedOutputCap', () => {
  it("asks for the model's full ceiling where it is known", () => {
    expect(raisedOutputCap('claude-opus-5-5')).toEqual({ maxTokens: 128_000 })
    expect(raisedOutputCap('claude-haiku-4-5')).toEqual({ maxTokens: 64_000 })
  })

  it('leaves the adapter default where it is not', () => {
    expect(raisedOutputCap('gpt-5.2')).toEqual({})
    expect(raisedOutputCap('llama3.3')).toEqual({})
  })
})
