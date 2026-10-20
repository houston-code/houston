import { describe, expect, it } from 'vitest'
import { displayLines, numberLines, numberWidth, numberedLine, stripLineNumbers } from './line-numbers'

describe('line-number format', () => {
  it('right-aligns the number to the width, then a tab', () => {
    expect(numberedLine(7, 3, 'x')).toBe('  7\tx')
    expect(numberWidth(9)).toBe(1)
    expect(numberWidth(10)).toBe(2)
    expect(numberWidth(0)).toBe(1)
  })

  it('counts lines the way an editor does', () => {
    expect(displayLines('')).toEqual([])
    expect(displayLines('a')).toEqual(['a'])
    expect(displayLines('a\n')).toEqual(['a'])
    expect(displayLines('a\n\n')).toEqual(['a', ''])
    expect(displayLines('a\r\nb')).toEqual(['a\r', 'b'])
  })

  it('numbers a 1-based inclusive range', () => {
    expect(numberLines(['a', 'b', 'c'], 2, 3, 2)).toBe(' 2\tb\n 3\tc')
  })
})

describe('stripLineNumbers', () => {
  it('removes a prefix copied onto every line, keeping a trailing newline', () => {
    expect(stripLineNumbers('  9\tfoo\n 10\t  bar\n')).toBe('foo\n  bar\n')
  })

  it('accepts a numbered blank line whose tab was trimmed off', () => {
    expect(stripLineNumbers('4\ta\n5\n6\tb')).toBe('a\n\nb')
  })

  it('leaves text alone unless every line carries a prefix', () => {
    expect(stripLineNumbers('3\tfoo\nbar')).toBeNull()
    expect(stripLineNumbers('plain text')).toBeNull()
    expect(stripLineNumbers('')).toBeNull()
  })

  it('does not take bare numbers without any tab for prefixes', () => {
    expect(stripLineNumbers('1\n2\n3')).toBeNull()
    expect(stripLineNumbers('42')).toBeNull()
  })

  it('with consecutive, requires the numbers to count up by one', () => {
    expect(stripLineNumbers('3\ta\n4\tb', { consecutive: true })).toBe('a\nb')
    expect(stripLineNumbers('3\ta\n5\tb', { consecutive: true })).toBeNull()
    // Without it (new_string, where the model may have dropped a line), gaps are fine.
    expect(stripLineNumbers('3\ta\n5\tb')).toBe('a\nb')
  })
})
