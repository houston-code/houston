import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewFinding } from '@shared/agent'
import type { ToolItem } from '../lib/items'
import { ToolGroup } from './ToolGroup'

/**
 * A diff line's full text. A modified line is split into per-token spans so the
 * changed WORDS can be marked inside it, so `getByText` no longer sees the line as
 * one node. This matches on the line's whole text content, which is still exact.
 */
function diffText(text: string, root?: HTMLElement): HTMLElement {
  const q = root ? within(root) : screen
  return q.getByText((_, el) => el?.classList.contains('diff__text') === true && el.textContent === text)
}

/** Build a ToolItem fixture from the real shape in lib/items.ts. */
function tool(over: Partial<ToolItem> & Pick<ToolItem, 'id' | 'name' | 'status'>): ToolItem {
  return { kind: 'tool', ...over } as ToolItem
}

describe('ToolGroup', () => {
  it('renders one row per call with its verb and target', () => {
    const items: ToolItem[] = [
      tool({ id: 'a', name: 'run_shell', status: 'done', args: { command: 'npm test' } }),
      tool({ id: 'b', name: 'edit_file', status: 'done', args: { path: 'src/app.ts' } })
    ]
    render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // describeTool maps run_shell → "Run <command>", edit_file → "Edit <path>".
    expect(screen.getByText('Run')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getByText('src/app.ts')).toBeInTheDocument()
  })

  it('hides a tool output until its row is expanded, then reveals it on click', () => {
    const items: ToolItem[] = [
      tool({
        id: 'a',
        name: 'run_shell',
        status: 'done',
        args: { command: 'echo hi' },
        output: 'hello from the shell'
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // Collapsed by default — the output is not in the DOM.
    expect(screen.queryByText('hello from the shell')).not.toBeInTheDocument()
    // A collapsed expandable row shows the ▸ chevron.
    expect(screen.getByText('▸')).toBeInTheDocument()

    const head = container.querySelector('.tool-row__head--clickable')
    expect(head).not.toBeNull()
    fireEvent.click(head as Element)

    // Now expanded: output is shown and the chevron flips to ▾.
    expect(screen.getByText('hello from the shell')).toBeInTheDocument()
    expect(screen.getByText('▾')).toBeInTheDocument()

    // Clicking again collapses it back.
    fireEvent.click(head as Element)
    expect(screen.queryByText('hello from the shell')).not.toBeInTheDocument()
  })

  it('expands an output row from the keyboard (Enter / Space)', () => {
    const items: ToolItem[] = [
      tool({ id: 'a', name: 'run_shell', status: 'done', args: { command: 'echo hi' }, output: 'shell output' })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)
    const head = container.querySelector('.tool-row__head--clickable') as HTMLElement
    // The row is a focusable button for assistive tech.
    expect(head).toHaveAttribute('role', 'button')
    expect(head).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(head, { key: 'Enter' })
    expect(screen.getByText('shell output')).toBeInTheDocument()
    fireEvent.keyDown(head, { key: ' ' })
    expect(screen.queryByText('shell output')).not.toBeInTheDocument()
  })

  it('does not make an output-less, diff-less row expandable', () => {
    const items: ToolItem[] = [
      tool({ id: 'a', name: 'run_shell', status: 'running', args: { command: 'sleep 1' } })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    expect(container.querySelector('.tool-row__head--clickable')).toBeNull()
    expect(screen.queryByText('▸')).not.toBeInTheDocument()
  })

  it('reflects status in the row class and glyph', () => {
    const { container, unmount } = render(
      <ToolGroup
        items={[tool({ id: 'a', name: 'run_shell', status: 'error', args: { command: 'x' }, output: 'boom' })]}
        onApprove={vi.fn()}
      />
    )
    expect(container.querySelector('.tool-row--error')).not.toBeNull()
    // Error glyph is ✕.
    expect(screen.getByText('✕')).toBeInTheDocument()
    unmount()

    render(
      <ToolGroup
        items={[tool({ id: 'b', name: 'edit_file', status: 'done', args: { path: 'p.ts' } })]}
        onApprove={vi.fn()}
      />
    )
    // Done glyph is ✓.
    expect(screen.getByText('✓')).toBeInTheDocument()
  })

  it('shows a labelled spinner (not a glyph) while a tool is running', () => {
    render(
      <ToolGroup
        items={[tool({ id: 'a', name: 'run_shell', status: 'running', args: { command: 'x' } })]}
        onApprove={vi.fn()}
      />
    )
    expect(screen.getByLabelText('running')).toBeInTheDocument()
  })

  it('shows approval buttons only for an awaiting-approval tool and reports the decision', () => {
    const onApprove = vi.fn()
    const { unmount } = render(
      <ToolGroup
        items={[tool({ id: 'done-1', name: 'edit_file', status: 'done', args: { path: 'p.ts' } })]}
        onApprove={onApprove}
      />
    )
    // A completed tool has no approval controls.
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    unmount()

    render(
      <ToolGroup
        items={[
          tool({
            id: 'call-7',
            name: 'edit_file',
            status: 'awaiting-approval',
            args: { path: 'p.ts', old_string: 'a', new_string: 'b' }
          })
        ]}
        onApprove={onApprove}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onApprove).toHaveBeenCalledWith('call-7', 'allow')

    fireEvent.click(screen.getByRole('button', { name: 'Allow for run' }))
    expect(onApprove).toHaveBeenCalledWith('call-7', 'always')

    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(onApprove).toHaveBeenCalledWith('call-7', 'rule-allow')

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprove).toHaveBeenCalledWith('call-7', 'deny', undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Always deny' }))
    expect(onApprove).toHaveBeenCalledWith('call-7', 'rule-deny', undefined)

    expect(onApprove).toHaveBeenCalledTimes(5)
  })

  it('opens the diff by default for an awaiting-approval edit and renders an add/del stat', () => {
    const items: ToolItem[] = [
      tool({
        id: 'a',
        name: 'edit_file',
        status: 'awaiting-approval',
        args: { path: 'src/x.ts', old_string: 'old line', new_string: 'new line' }
      })
    ]
    render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // The diff is shown without any click because the change is awaiting approval.
    expect(diffText('old line')).toBeInTheDocument()
    expect(diffText('new line')).toBeInTheDocument()
    // One line removed, one added.
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
  })

  it('folds a run of consecutive reads into one expandable "N files" row', () => {
    const items: ToolItem[] = [
      tool({ id: 'r1', name: 'read_file', status: 'done', args: { path: 'src/one.ts' } }),
      tool({ id: 'r2', name: 'read_file', status: 'done', args: { path: 'src/two.ts' } }),
      tool({ id: 'r3', name: 'read_file', status: 'done', args: { path: 'src/three.ts' } })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // Aggregate header summarises the run rather than listing every read up front.
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('3 files')).toBeInTheDocument()
    // Individual paths are hidden until the aggregate is expanded.
    expect(screen.queryByText('src/one.ts')).not.toBeInTheDocument()

    const head = container.querySelector('.tool-row__head--clickable')
    fireEvent.click(head as Element)

    const list = container.querySelector('.tool-reads')
    expect(list).not.toBeNull()
    expect(within(list as HTMLElement).getByText('src/one.ts')).toBeInTheDocument()
    expect(within(list as HTMLElement).getByText('src/two.ts')).toBeInTheDocument()
    expect(within(list as HTMLElement).getByText('src/three.ts')).toBeInTheDocument()
  })

  it('marks the group active while a tool is awaiting approval or running', () => {
    const { container, unmount } = render(
      <ToolGroup
        items={[tool({ id: 'a', name: 'run_shell', status: 'running', args: { command: 'x' } })]}
        onApprove={vi.fn()}
      />
    )
    expect(container.querySelector('.tool-group--active')).not.toBeNull()
    unmount()

    // A settled group is not active.
    const { container: c2 } = render(
      <ToolGroup
        items={[tool({ id: 'b', name: 'edit_file', status: 'done', args: { path: 'p.ts' } })]}
        onApprove={vi.fn()}
      />
    )
    expect(c2.querySelector('.tool-group--active')).toBeNull()
  })

  it('renders a todo_write tool as an inline checklist instead of an expandable row', () => {
    const items: ToolItem[] = [
      tool({
        id: 'a',
        name: 'todo_write',
        status: 'done',
        args: {
          todos: [
            { content: 'Write the parser', status: 'completed' },
            { content: 'Wire up the UI', status: 'in_progress' }
          ]
        }
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    expect(screen.getByText('Write the parser')).toBeInTheDocument()
    expect(screen.getByText('Wire up the UI')).toBeInTheDocument()
    // The todo list renders inline, so the row is not a clickable expandable head.
    expect(container.querySelector('.tool-row__head--clickable')).toBeNull()
    expect(container.querySelector('.todo-list')).not.toBeNull()
  })

  it('reflects a denied tool in the row class and glyph', () => {
    const { container } = render(
      <ToolGroup
        items={[
          tool({
            id: 'd',
            name: 'run_shell',
            status: 'denied',
            args: { command: 'rm -rf /' },
            output: 'Denied by user'
          })
        ]}
        onApprove={vi.fn()}
      />
    )
    expect(container.querySelector('.tool-row--denied')).not.toBeNull()
    // The denied glyph carries the status-specific modifier class…
    const glyph = container.querySelector('.tool-row__glyph--denied')
    expect(glyph).not.toBeNull()
    // …and is the ⊘ character (GLYPH.denied).
    expect(glyph?.textContent).toBe('⊘')
  })

  it('opens the diff by default for an awaiting-approval write_file and shows the +N stat', () => {
    const items: ToolItem[] = [
      tool({
        id: 'w',
        name: 'write_file',
        status: 'awaiting-approval',
        args: { path: 'src/new.ts', content: 'first line\nsecond line' }
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // A write diffs against empty, so both lines render as additions without a click.
    const diff = container.querySelector('.diff')
    expect(diff).not.toBeNull()
    expect(within(diff as HTMLElement).getByText('first line')).toBeInTheDocument()
    expect(within(diff as HTMLElement).getByText('second line')).toBeInTheDocument()
    // Two lines added, none removed.
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('−0')).toBeInTheDocument()
  })

  it('diffs a write_file against the file it overwrites, not against nothing', () => {
    // The gap this closes: with only args, a write_file over an existing file renders
    // every line as new. The preview carries what the file actually held.
    const items: ToolItem[] = [
      tool({
        id: 'w',
        name: 'write_file',
        status: 'awaiting-approval',
        args: { path: 'src/x.ts', content: 'keep\nchanged\n' },
        preview: [
          {
            path: 'src/x.ts',
            diff: [
              { type: 'ctx', text: 'keep' },
              { type: 'del', text: 'was here' },
              { type: 'add', text: 'changed' }
            ]
          }
        ]
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    const diff = container.querySelector('.diff')
    expect(diffText('was here', diff as HTMLElement)).toBeInTheDocument()
    // One line each way, rather than the whole file counted as added.
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    // A plain overwrite of an existing file needs no per-file header: the row says it.
    expect(container.querySelector('.tool-row__diff-head')).toBeNull()
  })

  it('renders a diff for multi_edit, which previously had none at all', () => {
    const items: ToolItem[] = [
      tool({
        id: 'm',
        name: 'multi_edit',
        status: 'awaiting-approval',
        args: { path: 'src/m.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
        preview: [
          {
            path: 'src/m.ts',
            diff: [
              { type: 'del', text: 'a' },
              { type: 'add', text: 'b' }
            ]
          }
        ]
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)
    expect(container.querySelector('.diff')).not.toBeNull()
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('renders one diff per file for a multi-file apply_patch, with headers and tags', () => {
    const items: ToolItem[] = [
      tool({
        id: 'p',
        name: 'apply_patch',
        status: 'awaiting-approval',
        args: { patch: '*** Begin Patch\n…' },
        preview: [
          { path: 'src/new.ts', created: true, diff: [{ type: 'add', text: 'export const x = 1' }] },
          {
            path: 'src/keep.ts',
            diff: [
              { type: 'del', text: 'const b = 2' },
              { type: 'add', text: 'const b = 3' }
            ]
          },
          { path: 'src/gone.ts', deleted: true, diff: [{ type: 'del', text: 'bye' }] }
        ]
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // Three files, each with its own labelled diff.
    expect(container.querySelectorAll('.diff')).toHaveLength(3)
    expect(screen.getByText('src/new.ts')).toBeInTheDocument()
    expect(screen.getByText('src/keep.ts')).toBeInTheDocument()
    expect(screen.getByText('src/gone.ts')).toBeInTheDocument()
    expect(screen.getByText('new file')).toBeInTheDocument()
    expect(screen.getByText('deleted')).toBeInTheDocument()
    // The stat sums the whole patch, not just its first file.
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('−2')).toBeInTheDocument()
  })

  it('labels a renamed file with where it came from', () => {
    const items: ToolItem[] = [
      tool({
        id: 'p',
        name: 'apply_patch',
        status: 'awaiting-approval',
        args: { patch: '…' },
        preview: [
          { path: 'src/new.ts', renamedFrom: 'src/old.ts', diff: [{ type: 'add', text: 'x' }] }
        ]
      })
    ]
    render(<ToolGroup items={items} onApprove={vi.fn()} />)
    expect(screen.getByText('renamed from src/old.ts')).toBeInTheDocument()
  })

  it('says so when a preview was cut short rather than implying it is the whole change', () => {
    const items: ToolItem[] = [
      tool({
        id: 'w',
        name: 'write_file',
        status: 'awaiting-approval',
        args: { path: 'big.ts', content: 'x' },
        preview: [{ path: 'big.ts', truncated: true, diff: [{ type: 'add', text: 'line' }] }]
      })
    ]
    render(<ToolGroup items={items} onApprove={vi.fn()} />)
    expect(screen.getByText(/change continues past this point/)).toBeInTheDocument()
  })

  it('falls back to the args-derived diff for a row with no preview', () => {
    // Conversations persisted before previews existed still render what they can.
    const items: ToolItem[] = [
      tool({
        id: 'a',
        name: 'edit_file',
        status: 'done',
        args: { path: 'src/x.ts', old_string: 'old line', new_string: 'new line' }
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)
    fireEvent.click(container.querySelector('.tool-row__head') as HTMLElement)
    expect(diffText('old line')).toBeInTheDocument()
    expect(diffText('new line')).toBeInTheDocument()
  })

  it('renders the correct mark for each todo status', () => {
    const items: ToolItem[] = [
      tool({
        id: 't',
        name: 'todo_write',
        status: 'done',
        args: {
          todos: [
            { content: 'Pending item', status: 'pending' },
            { content: 'Active item', status: 'in_progress' },
            { content: 'Finished item', status: 'completed' }
          ]
        }
      })
    ]
    render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // TODO_MARK: pending ○, in_progress ◐, completed ●.
    const pendingLi = screen.getByText('Pending item').closest('li')
    const activeLi = screen.getByText('Active item').closest('li')
    const doneLi = screen.getByText('Finished item').closest('li')
    expect(pendingLi?.querySelector('.todo__mark')?.textContent).toBe('○')
    expect(activeLi?.querySelector('.todo__mark')?.textContent).toBe('◐')
    expect(doneLi?.querySelector('.todo__mark')?.textContent).toBe('●')
  })

  it('renders an image for a tool that produced screenshots', () => {
    const items: ToolItem[] = [
      tool({
        id: 'v',
        name: 'view_localhost',
        status: 'done',
        args: { url: 'http://localhost:3000' },
        images: [
          { mediaType: 'image/png', data: 'AAAA' },
          { mediaType: 'image/jpeg', data: 'BBBB' }
        ]
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    const imgs = container.querySelectorAll('img.tool-row__image')
    expect(imgs).toHaveLength(2)
    // src is a data: URL built from mediaType + base64 data; alt is "screenshot".
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(imgs[0].getAttribute('alt')).toBe('screenshot')
    expect(imgs[1].getAttribute('src')).toBe('data:image/jpeg;base64,BBBB')
  })

  it('renders nested subagent rows under a review tool, each with its own live status', () => {
    const items: ToolItem[] = [
      tool({
        id: 'rev',
        name: 'review_changes',
        status: 'running',
        args: {},
        subagents: [
          { id: 'correctness', label: 'Correctness — 2 issues', status: 'done' },
          { id: 'security', label: 'Security', status: 'running' },
          { id: 'verify', label: 'Verifying findings', status: 'running' }
        ]
      })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // One row per subagent, each showing its label.
    expect(container.querySelectorAll('.tool-row__subagent')).toHaveLength(3)
    expect(screen.getByText('Correctness — 2 issues')).toBeInTheDocument()
    expect(screen.getByText('Security')).toBeInTheDocument()
    // A finished dimension shows the done glyph; a still-working one shows a spinner.
    const done = screen.getByText('Correctness — 2 issues').closest('.tool-row__subagent')
    expect(done?.querySelector('.tool-row__glyph--done')).not.toBeNull()
    const running = screen.getByText('Security').closest('.tool-row__subagent')
    expect(running?.querySelector('[aria-label="running"]')).not.toBeNull()
  })

  describe('live review findings', () => {
    const finding = (id: string, over: Partial<ReviewFinding> = {}): ReviewFinding => ({
      id,
      dimension: 'security',
      severity: 'medium',
      title: `title ${id}`,
      status: 'candidate',
      ...over
    })
    const review = (status: ToolItem['status'], findings: ReviewFinding[]): ToolItem[] => [
      tool({ id: 'rev', name: 'review_changes', status, args: {}, findings })
    ]

    it('shows findings while the review runs, most severe first, with their live status', () => {
      const { container } = render(
        <ToolGroup
          items={review('running', [
            finding('q:0', { severity: 'low', status: 'candidate' }),
            finding('s:0', { severity: 'high', location: 'src/api.ts:88', status: 'verifying', votes: { confirmed: 1, cast: 1, total: 3 } }),
            finding('c:0', { severity: 'medium', status: 'rejected' })
          ])}
          onApprove={vi.fn()}
        />
      )
      const rows = [...container.querySelectorAll('.finding')]
      expect(rows.map((r) => r.querySelector('.finding__sev')?.textContent)).toEqual(['high', 'medium', 'low'])
      expect(within(rows[0] as HTMLElement).getByText('src/api.ts:88')).toBeInTheDocument()
      expect(within(rows[0] as HTMLElement).getByText('1/3')).toBeInTheDocument()
      // A rejected finding stays in place, struck through, while the review is running.
      expect(rows[1].classList.contains('finding--rejected')).toBe(true)
      expect(within(rows[2] as HTMLElement).getByText('◇ unverified')).toBeInTheDocument()
      expect(screen.getByText('2 found so far')).toBeInTheDocument()
    })

    it('folds dropped findings behind a toggle once the review is done, and tallies the rest', () => {
      const { container } = render(
        <ToolGroup
          items={review('done', [
            finding('s:0', { severity: 'high', status: 'confirmed' }),
            finding('c:0', { status: 'rejected' }),
            finding('c:1', { status: 'merged' })
          ])}
          onApprove={vi.fn()}
        />
      )
      expect(container.querySelectorAll('.finding')).toHaveLength(1)
      const tally = screen.getByText('1 high')
      expect(tally.classList.contains('tool-row__tally--alarm')).toBe(true)
      const toggle = screen.getByRole('button', { name: /1 dropped as a false positive, 1 merged as a duplicate/ })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(toggle)
      expect(container.querySelectorAll('.finding')).toHaveLength(3)
    })

    it('says no confirmed issues when every finding was dropped', () => {
      render(<ToolGroup items={review('done', [finding('c:0', { status: 'rejected' })])} onApprove={vi.fn()} />)
      expect(screen.getByText('no confirmed issues')).toBeInTheDocument()
    })

    it('expands a finding to show why and the fix, as plain text', () => {
      render(
        <ToolGroup
          items={review('done', [finding('s:0', { status: 'confirmed', title: 'Hole', detail: 'Why: <b>x</b>\nFix: y' })])}
          onApprove={vi.fn()}
        />
      )
      const head = screen.getByRole('button', { name: /Hole/ })
      expect(screen.queryByText(/Fix: y/)).toBeNull()
      fireEvent.click(head)
      expect(head).toHaveAttribute('aria-expanded', 'true')
      const detail = screen.getByText(/Fix: y/)
      expect(detail.textContent).toContain('<b>x</b>')
      expect(detail.querySelector('b')).toBeNull()
    })
  })

  it('shows the highest-priority status on a fold of reads with mixed statuses', () => {
    // A fold needs ≥2 consecutive read_file calls. One running + one done should
    // surface as running (running outranks done in combinedStatus).
    const items: ToolItem[] = [
      tool({ id: 'm1', name: 'read_file', status: 'done', args: { path: 'src/one.ts' } }),
      tool({ id: 'm2', name: 'read_file', status: 'running', args: { path: 'src/two.ts' } })
    ]
    const { container } = render(<ToolGroup items={items} onApprove={vi.fn()} />)

    // The aggregate row reflects the combined (running) status.
    expect(container.querySelector('.tool-row--running')).not.toBeNull()
    // Running shows the labelled spinner, not a settled glyph — and the header has it.
    const head = container.querySelector('.tool-row__head')
    expect(head?.querySelector('[aria-label="running"]')).not.toBeNull()
    expect(screen.getByText('2 files')).toBeInTheDocument()
  })

  // Guidance rides the same interaction as the refusal: without it a denial is a
  // dead end and the agent just retries a variant.
  it('sends the typed reason with a denial', () => {
    const onApprove = vi.fn()
    render(
      <ToolGroup
        items={[
          tool({
            id: 'call-9',
            name: 'run_shell',
            status: 'awaiting-approval',
            args: { command: 'aws s3 cp x s3://prod' }
          })
        ]}
        onApprove={onApprove}
      />
    )
    const reason = screen.getByLabelText('Reason for denying, sent to the agent')
    fireEvent.change(reason, { target: { value: 'use the staging bucket' } })
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprove).toHaveBeenCalledWith('call-9', 'deny', 'use the staging bucket')
  })

  it('denies with the reason on Enter in the reason box', () => {
    const onApprove = vi.fn()
    render(
      <ToolGroup
        items={[tool({ id: 'call-10', name: 'run_shell', status: 'awaiting-approval', args: {} })]}
        onApprove={onApprove}
      />
    )
    const reason = screen.getByLabelText('Reason for denying, sent to the agent')
    fireEvent.change(reason, { target: { value: 'not that file' } })
    fireEvent.keyDown(reason, { key: 'Enter' })
    expect(onApprove).toHaveBeenCalledWith('call-10', 'deny', 'not that file')
  })

  it('offers no reason box on the shell-network consent (a yes/no about egress)', () => {
    render(
      <ToolGroup
        items={[
          tool({
            id: 'call-11',
            name: 'run_shell',
            status: 'awaiting-approval',
            shellNetwork: true,
            args: {}
          })
        ]}
        onApprove={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('Reason for denying, sent to the agent')).not.toBeInTheDocument()
  })
})
