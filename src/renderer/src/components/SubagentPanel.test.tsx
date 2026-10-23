import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { resumeNote, type SubagentRecord, type SubagentStep } from '@shared/subagents'
import type { ToolItem } from '../lib/items'
import { ToolGroup } from './ToolGroup'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))
import { copyText } from '../lib/clipboard'

function step(index: number, over: Partial<SubagentStep> = {}): SubagentStep {
  return { index, turn: index + 1, kind: 'tool', tool: 'read_file', summary: `Read f${index}.ts`, ok: true, hint: '3 lines', ...over }
}

function record(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: 'sa1',
    kind: 'research',
    label: 'Trace the download flow',
    model: 'claude-haiku-5-5',
    modelSource: 'argument',
    prompt: 'Explain how **downloads** work.',
    systemPrompt: 'You are a research subagent.',
    tools: ['read_file', 'search_files'],
    status: 'done',
    startedAt: 0,
    endedAt: 14_000,
    budget: { used: 4, limit: 40, ceiling: 200 },
    usage: { input: 3600, output: 610, costUsd: 0.004 },
    resumeId: 'ag1',
    report: '## Download flow\n\n- `sendFile` is unsafe',
    steps: [step(0, { output: 'line one\n<img src=x onerror=alert(1)>' }), step(1)],
    ...over
  }
}

function row(over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool',
    id: 'c1',
    name: 'dispatch_agent',
    status: 'done',
    args: { description: 'Trace the download flow' },
    output: `## Download flow\n\n- \`sendFile\` is unsafe\n\n${resumeNote('ag1', 'dispatch_agent')}`,
    records: [record()],
    ...over
  } as ToolItem
}

const head = (c: HTMLElement): HTMLElement => c.querySelector('.tool-row__head') as HTMLElement

describe('subagent rows', () => {
  it('shows a finished agent collapsed, with its summary chips and no raw resume note', () => {
    const { container } = render(<ToolGroup items={[row()]} onApprove={vi.fn()} />)
    const chips = container.querySelector('.sa-chips') as HTMLElement
    expect(within(chips).getByText('claude-haiku-5-5')).toBeInTheDocument()
    expect(within(chips).getByText('2 steps')).toBeInTheDocument()
    expect(within(chips).getByText('14s')).toBeInTheDocument()
    expect(within(chips).getByText('≈$0.0040')).toBeInTheDocument()
    expect(within(chips).getByText('ag1')).toBeInTheDocument()
    expect(container.querySelector('.sa-body')).toBeNull()
    expect(screen.queryByText(/pass resume/)).not.toBeInTheDocument()
  })

  it('opens on the rendered report, then switches tabs by click and arrow key', () => {
    const { container } = render(<ToolGroup items={[row()]} onApprove={vi.fn()} />)
    fireEvent.click(head(container))
    expect(screen.getByRole('heading', { name: 'Download flow' })).toBeInTheDocument()
    expect(screen.queryByText(/pass resume/)).not.toBeInTheDocument()
    expect(screen.getByText(/Resumable as/)).toBeInTheDocument()

    const report = screen.getByRole('tab', { name: 'Report' })
    expect(report).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(report, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: /Steps/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Read f0.ts')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Prompt & setup' }))
    expect(screen.getByText('downloads').closest('strong')).not.toBeNull()
    expect(screen.getByText(/chosen by the main agent/)).toBeInTheDocument()
    expect(screen.getByText('search_files')).toBeInTheDocument()
    expect(screen.getByText(/4 used of 40, extends while productive \(up to 200\)/)).toBeInTheDocument()
    expect(screen.getByText(/System prompt \(28 characters\)/)).toBeInTheDocument()
  })

  it('expands a step to its result as inert text', () => {
    const { container } = render(<ToolGroup items={[row()]} onApprove={vi.fn()} />)
    fireEvent.click(head(container))
    fireEvent.click(screen.getByRole('tab', { name: /Steps/ }))
    fireEvent.click(screen.getByText('Read f0.ts'))
    const out = container.querySelector('.sa-out') as HTMLElement
    expect(out.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
  })

  it('streams steps while running, with a nested agent in its own block', () => {
    const live = row({
      status: 'running',
      output: undefined,
      records: [
        record({
          status: 'running',
          endedAt: undefined,
          resumeId: undefined,
          report: undefined,
          steps: [step(0), step(1, { tool: 'dispatch_agent', summary: 'Subagent: Find callers', ok: undefined, childId: 'sa2', hint: undefined })]
        }),
        record({ id: 'sa2', parentId: 'sa1', label: 'Find callers', status: 'running', endedAt: undefined, steps: [step(0, { summary: 'Search "sendFile"', ok: undefined, hint: undefined })] })
      ]
    })
    const { container } = render(<ToolGroup items={[live]} onApprove={vi.fn()} />)
    expect(screen.getByText('Read f0.ts')).toBeInTheDocument()
    expect(screen.getByText('step 2')).toBeInTheDocument()
    const nested = container.querySelector('.sa-nested') as HTMLElement
    expect(within(nested).getByText('Find callers')).toBeInTheDocument()
    expect(within(nested).getByText('Search "sendFile"')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('warns when an agent stopped at its max_turns', () => {
    const capped = row({ records: [record({ status: 'step-limit', budget: { used: 12, limit: 12, ceiling: 12, hardCap: 12 } })] })
    const { container } = render(<ToolGroup items={[capped]} onApprove={vi.fn()} />)
    expect(within(container.querySelector('.sa-chips') as HTMLElement).getByText('12 of 12 steps')).toBeInTheDocument()
    fireEvent.click(head(container))
    expect(screen.getByText(/max_turns: 12 in its agent file/)).toBeInTheDocument()
  })

  it('renders an old chat’s report as markdown without the note, even with no record', () => {
    const { container } = render(<ToolGroup items={[row({ records: undefined })]} onApprove={vi.fn()} />)
    fireEvent.click(head(container))
    expect(screen.getByRole('heading', { name: 'Download flow' })).toBeInTheDocument()
    expect(screen.queryByText(/pass resume/)).not.toBeInTheDocument()
    expect(screen.getByText(/Resumable as ag1/)).toBeInTheDocument()
  })

  it('opens the full transcript, copies it as Markdown, and closes on Escape', async () => {
    const { container } = render(<ToolGroup items={[row()]} onApprove={vi.fn()} />)
    fireEvent.click(head(container))
    fireEvent.click(screen.getByRole('button', { name: 'Open transcript' }))
    const dialog = screen.getByRole('dialog', { name: /Subagent transcript/ })
    expect(within(dialog).getByText('Subagent ag1 · Trace the download flow')).toBeInTheDocument()
    expect(within(dialog).getByText('Step 1')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy as Markdown' }))
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith(expect.stringContaining('## Trace the download flow')))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('links a review row to what each of its agents did', () => {
    const review: ToolItem = {
      kind: 'tool',
      id: 'r1',
      name: 'review_changes',
      status: 'done',
      output: 'review',
      records: [record({ id: 'sa1', kind: 'reviewer', label: 'Correctness reviewer', resumeId: undefined }), record({ id: 'sa2', kind: 'reviewer', label: 'Verifier', resumeId: undefined })]
    } as ToolItem
    render(<ToolGroup items={[review]} onApprove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'See what its 2 agents did' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verifier' }))
    expect(within(dialog).getByRole('heading', { name: 'Verifier' })).toBeInTheDocument()
  })
})

describe('subagent steps: a denied call', () => {
  it('shows a step the user denied in their terms, not the instruction to the subagent', () => {
    const denied = step(0, {
      tool: 'run_shell',
      summary: 'Run rm -rf build',
      ok: false,
      output:
        'Denied by the user. Do not retry this command; work around it or note it in your report. They said: not here'
    })
    const { container } = render(<ToolGroup items={[row({ records: [record({ steps: [denied] })] })]} onApprove={vi.fn()} />)
    fireEvent.click(head(container))
    fireEvent.click(screen.getByRole('tab', { name: /Steps/ }))
    fireEvent.click(screen.getByText('Run rm -rf build'))
    expect((container.querySelector('.sa-out') as HTMLElement).textContent).toBe('Denied: not here')
  })
})
