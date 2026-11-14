import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiffView } from './DiffView'
import { diffLines, hunkDiff, type DiffLine } from '@shared/diff'

/**
 * The approval card is where someone decides whether to let a change happen. The
 * terminal has shown a numbered gutter and marked the changed WORDS since the diff
 * rewrite; the desktop app showed neither, so the same edit read as a solid red
 * line and a solid green one and you had to spot the difference by eye.
 *
 * Both clients now render from the same helpers in `@shared/diff`, so these tests
 * are really about the two of them agreeing.
 */

/** The rendered gutter numbers, in order, skipping the blanks. */
function gutter(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.diff__no')].map((n) => n.textContent ?? '').filter(Boolean)
}

describe('DiffView', () => {
  it('numbers the lines it shows', () => {
    const { container } = render(<DiffView diff={diffLines('a\nb\nc', 'a\nB\nc')} />)
    // a=1, then the b→B replacement, then c.
    expect(gutter(container)).toEqual(['1', '2', '2', '3'])
  })

  it('marks only the words that changed inside a modified line', () => {
    const { container } = render(
      <DiffView diff={diffLines('const timeout = 30', 'const timeout = 60')} />
    )
    const marks = [...container.querySelectorAll('.diff__word')].map((m) => m.textContent)
    expect(marks).toEqual(['30', '60'])
    // The unchanged words are still there — marking is emphasis, not a filter.
    expect(container.textContent).toContain('const timeout')
  })

  it('does not invent word marks on a plain insert or delete', () => {
    const { container } = render(<DiffView diff={diffLines('a\nc', 'a\nb\nc')} />)
    // `b` is an addition with no partner: the whole line is the change.
    expect(container.querySelectorAll('.diff__word')).toHaveLength(0)
  })

  // Getting this wrong makes every number after the first fold a lie, which is
  // worse than showing no numbers at all.
  it('keeps numbering correct across a fold', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')
    const after = before.replace('line25', 'CHANGED')
    const { container } = render(<DiffView diff={hunkDiff(diffLines(before, after), 2)} />)
    const nums = gutter(container)
    // The changed line is #25 in both files, and survives the fold with that number.
    expect(nums).toContain('25')
    expect(container.textContent).toContain('CHANGED')
  })

  it('shows a fold as an aside, not as code', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')
    const after = before.replace('line25', 'CHANGED')
    const { container } = render(<DiffView diff={hunkDiff(diffLines(before, after), 2)} />)
    const skip = container.querySelector('.diff__line--skip')
    expect(skip).not.toBeNull()
    // A skip has no line number of its own — it stands for many.
    expect(skip?.querySelector('.diff__no')?.textContent).toBe('')
  })

  it('caps a huge diff rather than rendering all of it', () => {
    const big: DiffLine[] = Array.from({ length: 400 }, (_, i) => ({ type: 'add', text: `l${i}` }))
    render(<DiffView diff={big} />)
    expect(screen.getByText(/100 more lines/)).toBeInTheDocument()
  })

  it('reveals the rest of a long diff one chunk at a time', () => {
    const big: DiffLine[] = Array.from({ length: 700 }, (_, i) => ({ type: 'add', text: `l${i}` }))
    const { container } = render(<DiffView diff={big} />)
    expect(container.querySelectorAll('.diff__line')).toHaveLength(300)
    expect(screen.getByText('400 hidden')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show 300 more lines' }))
    expect(container.querySelectorAll('.diff__line')).toHaveLength(600)
    // The last chunk names what is actually left.
    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more lines' }))
    expect(container.querySelectorAll('.diff__line')).toHaveLength(700)
    expect(container.textContent).toContain('l699')
    expect(screen.queryByRole('button', { name: /more line/ })).toBeNull()
  })

  it('renders past the cap through a line that must stay visible', () => {
    const big: DiffLine[] = Array.from({ length: 700 }, (_, i) => ({ type: 'add', text: `l${i}` }))
    const { container } = render(<DiffView diff={big} reveal={new Set(['new:450'])} />)
    // Whole chunks: through line 450 means two of them.
    expect(container.querySelectorAll('.diff__line')).toHaveLength(600)
    expect(screen.getByText('100 hidden')).toBeInTheDocument()
  })

  it('renders an empty diff without falling over', () => {
    const { container } = render(<DiffView diff={[]} />)
    expect(container.querySelectorAll('.diff__line')).toHaveLength(0)
  })

  it('numbers a hunk from where it sits in its file', () => {
    const { container } = render(
      <DiffView
        diff={[
          { type: 'ctx', text: 'a' },
          { type: 'del', text: 'b' },
          { type: 'add', text: 'c' }
        ]}
        start={{ old: 40, new: 42 }}
      />
    )
    expect(gutter(container)).toEqual(['42', '41', '43'])
  })

  it('colours code by the file type and still marks the changed words', () => {
    const { container } = render(<DiffView diff={diffLines('const a = 1', 'const a = 22')} path="x.ts" />)
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const')
    const marks = [...container.querySelectorAll('.diff__line--add mark.diff__word')].map((m) => m.textContent)
    expect(marks.join('')).toBe('22')
    // The line reads exactly as written.
    expect(container.querySelector('.diff__line--add .diff__text')?.textContent).toBe('const a = 22')
  })

  it('lays the old side beside the new side', () => {
    const { container } = render(
      <DiffView diff={diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')} layout="split" />
    )
    const rows = [...container.querySelectorAll('.diff__row')].map((r) =>
      [...r.querySelectorAll('.diff__line')].map((l) => l.querySelector('.diff__text')?.textContent ?? '')
    )
    expect(rows).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'c'],
      ['', 'd']
    ])
    expect(container.querySelectorAll('.diff__line--empty')).toHaveLength(1)
  })

  it('opens a comment from a line click or its number, and shows what goes under a line', () => {
    const clicks: unknown[] = []
    const { container } = render(
      <DiffView
        diff={diffLines('a\nb\n', 'a\nc\n')}
        path="f.ts"
        onLineClick={(t) => clicks.push(t)}
        renderBelow={(key) => (key === 'new:2' ? <p>note under c</p> : null)}
      />
    )
    screen.getByRole('button', { name: 'Comment on removed line 2 of f.ts' }).click()
    ;(container.querySelector('.diff__line--add') as HTMLElement).click()
    expect(clicks).toEqual([
      { side: 'old', line: 2, text: 'b' },
      { side: 'new', line: 2, text: 'c' }
    ])
    expect(screen.getByText('note under c')).toBeInTheDocument()
    // Without onLineClick the numbers stay plain text.
    const { container: plain } = render(<DiffView diff={diffLines('a', 'b')} />)
    expect(plain.querySelector('button')).toBeNull()
  })

  it('side by side, comments on an unchanged line from either half as the line its comments show under', () => {
    const clicks: { side: string; line: number }[] = []
    const { container } = render(
      <DiffView
        diff={diffLines('x\na\n', 'a\n')}
        path="f.ts"
        layout="split"
        onLineClick={(t) => clicks.push(t)}
        renderBelow={(key) => (key === 'new:1' ? <p>note under a</p> : null)}
      />
    )
    const ctx = [...container.querySelectorAll('.diff__line--ctx')] as HTMLElement[]
    expect(ctx).toHaveLength(2)
    ctx[0].click()
    ctx[1].click()
    expect(clicks).toEqual([
      { side: 'new', line: 1, text: 'a' },
      { side: 'new', line: 1, text: 'a' }
    ])
    // One note under the row, and one keyboard button for the line, not a second "removed line" one.
    expect(screen.getAllByText('note under a')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Comment on .*line 1 of f.ts/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Comment on removed line 1 of f.ts',
      'Comment on line 1 of f.ts'
    ])
  })
})

