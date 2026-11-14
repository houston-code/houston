import { describe, expect, it } from 'vitest'
import { parseShellEscape, plainTerminalText, renderShellEscapeRecord } from './shellEscape'
import { shellEscapeTurn } from './promptInvocation'

describe('parseShellEscape', () => {
  it('takes a leading-! line as a command, and nothing else', () => {
    expect(parseShellEscape('!npm test')).toBe('npm test')
    expect(parseShellEscape('!')).toBeNull()
    expect(parseShellEscape('fix the !important rule')).toBeNull()
  })
})

// A terminal tab is a real TTY: what it printed has to be read back as the text
// that was on screen before the model sees it.
describe('plainTerminalText', () => {
  it('drops colors and cursor control', () => {
    expect(plainTerminalText('\x1b[31mFAIL\x1b[0m a.test.ts\x1b[K\r\n')).toBe('FAIL a.test.ts\n')
  })

  it('drops a title or hyperlink sequence but keeps the visible text', () => {
    expect(plainTerminalText('\x1b]0;npm test\x07ok')).toBe('ok')
    expect(plainTerminalText('\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
  })

  it('keeps only the last redraw of a progress line', () => {
    expect(plainTerminalText('10%\r50%\r100%\ndone')).toBe('100%\ndone')
  })

  it('keeps a line that ends in a carriage return', () => {
    expect(plainTerminalText('building\r')).toBe('building')
  })

  it('drops other control characters but keeps tabs', () => {
    expect(plainTerminalText('a\tb\x07\x08c')).toBe('a\tbc')
  })
})

describe('shellEscapeTurn', () => {
  it('records the output for the model and the command for the chat', () => {
    const turn = shellEscapeTurn('npm test', '2 failed', 1)
    expect(turn.text).toBe(renderShellEscapeRecord('npm test', '2 failed', 1))
    expect(turn.text).toContain('exited 1')
    expect(turn.invokedAs).toEqual({
      kind: 'command',
      label: '!npm test',
      detail: 'Ran in the terminal, exited 1',
      typed: '!npm test'
    })
  })

  it('says nothing about the exit when it succeeded', () => {
    expect(shellEscapeTurn('ls', 'a', 0).invokedAs.detail).toBe('Ran in the terminal')
  })
})
