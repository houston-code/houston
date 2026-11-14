import { describe, it, expect } from 'vitest'
import { envFlag, plainText, resolveAccessibility } from './tui-a11y'
import { makePainter, renderContextUsage, renderTodoList } from './tui'

describe('envFlag', () => {
  it('reads the usual truthy spellings, any case', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) expect(envFlag(v)).toBe(true)
  })
  it('treats anything else, unset included, as off', () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) expect(envFlag(v)).toBe(false)
  })
})

describe('resolveAccessibility', () => {
  it('turns reduced motion on from the env var or the setting', () => {
    expect(resolveAccessibility({}, {}, {}).reduceMotion).toBe(false)
    expect(resolveAccessibility({}, { HOUSTON_REDUCE_MOTION: '1' }, {}).reduceMotion).toBe(true)
    expect(resolveAccessibility({}, {}, { reduceMotion: true }).reduceMotion).toBe(true)
    expect(resolveAccessibility({}, { HOUSTON_REDUCE_MOTION: '0' }, { reduceMotion: false }).reduceMotion).toBe(false)
  })

  it('turns screen-reader mode on from the flag, the env var or the setting', () => {
    expect(resolveAccessibility({}, {}, {}).screenReader).toBe(false)
    expect(resolveAccessibility({ screenReader: true }, {}, {}).screenReader).toBe(true)
    expect(resolveAccessibility({}, { HOUSTON_SCREEN_READER: '1' }, {}).screenReader).toBe(true)
    expect(resolveAccessibility({}, {}, { tuiScreenReader: true }).screenReader).toBe(true)
  })

  it('keeps the reduced-motion preference apart from screen-reader mode', () => {
    // The driver applies the implication; turning screen-reader mode off later must
    // not leave motion reduced for someone who never chose that.
    expect(resolveAccessibility({ screenReader: true }, {}, {})).toEqual({ screenReader: true, reduceMotion: false })
  })
})

describe('plainText', () => {
  const ESC = String.fromCharCode(27)

  it('drops every escape: color, cursor moves, erases, titles and links', () => {
    const s = `${ESC}[36mcyan${ESC}[0m ${ESC}[2K${ESC}[3A${ESC}]0;title${String.fromCharCode(7)}${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\`
    expect(plainText(s)).toBe('cyan link')
  })

  it('drops a bare carriage return but keeps CRLF as a line end', () => {
    expect(plainText('a\rb')).toBe('ab')
    expect(plainText('a\r\nb')).toBe('a\nb')
  })

  it('reads the context meter as words', () => {
    const meter = renderContextUsage(60_000, 'claude-sonnet-4-5', makePainter(false))
    expect(plainText(meter)).toMatch(/^context \d+%$/)
  })

  it('turns status marks into words and drops decorative bullets', () => {
    expect(plainText('· Read  src/a.ts')).toBe('Read  src/a.ts')
    expect(plainText('  ↳ allowed')).toBe('  allowed')
    expect(plainText('  ✗ failed to run')).toBe('  failed: failed to run')
    expect(plainText('⚠ runs UNSANDBOXED')).toBe('warning: runs UNSANDBOXED')
    const todo = plainText(
      renderTodoList(
        [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'pending' }
        ],
        makePainter(false)
      )
    )
    expect(todo).toBe('todo\n    done: a\n    in progress: b\n    to do: c')
  })

  it('reads separators and arrows as words, and drops box rules', () => {
    expect(plainText('model · ask · ~/proj')).toBe('model, ask, ~/proj')
    expect(plainText('· approval → Ask')).toBe('approval to Ask')
    expect(plainText('a │ b')).toBe('a, b')
    expect(plainText('────────')).toBe('')
    expect(plainText('  you › hi\n  houston › hello')).toBe('  you: hi\n  houston: hello')
  })

  it('leaves the words of a reply alone', () => {
    const reply = 'Use a·b as a product, or 3 → 4 in prose? x•y stays.'
    expect(plainText(reply)).toBe('Use a·b as a product, or 3 to 4 in prose? x•y stays.')
  })
})
