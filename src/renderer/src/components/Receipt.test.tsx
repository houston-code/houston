import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TurnReceipt } from '@shared/evidence'
import { Receipt } from './Receipt'

const receipt = (over: Partial<TurnReceipt> = {}): TurnReceipt => ({
  v: 1,
  checks: [
    { kind: 'install', label: 'pip install -r requirements.txt', ok: false, exitCode: 1, blocked: 'network', runs: 1 },
    { kind: 'server', label: 'npm run dev', ok: null, unknown: 'background', background: true, runs: 1 }
  ],
  otherCommands: 3,
  filesChanged: ['backend/main.py', 'frontend/src/App.jsx'],
  filesChangedCount: 2,
  ...over
})

describe('Receipt', () => {
  it('shows one summary line under a "What ran" heading, collapsed', () => {
    const { container } = render(<Receipt receipt={receipt()} />)
    expect(screen.getByText('What ran')).toBeInTheDocument()
    expect(screen.getByText('No tests ran · install failed (no network) · server started · 2 files changed')).toBeInTheDocument()
    expect(container.querySelector('details')?.open).toBe(false)
  })

  it('expands to each check, the commands not listed, and the files changed', () => {
    const { container } = render(<Receipt receipt={receipt()} />)
    fireEvent.click(screen.getByText('What ran'))
    expect(container.querySelector('details')?.open).toBe(true)
    expect(screen.getByText('pip install -r requirements.txt')).toBeInTheDocument()
    expect(screen.getByText('exit 1, no network')).toBeInTheDocument()
    expect(screen.getByText('started in the background')).toBeInTheDocument()
    expect(screen.getByText('Plus 3 other commands.')).toBeInTheDocument()
    expect(screen.getByText('backend/main.py')).toBeInTheDocument()
  })

  it('says each outcome in words for screen readers, not only with a glyph', () => {
    render(<Receipt receipt={receipt()} />)
    expect(screen.getByText('failed:', { exact: false })).toHaveClass('sr-only')
    expect(screen.getByText('outcome unknown:', { exact: false })).toHaveClass('sr-only')
  })

  it('marks a receipt with a failed check', () => {
    const { container, rerender } = render(<Receipt receipt={receipt()} />)
    expect(container.querySelector('.receipt--failed')).not.toBeNull()
    rerender(<Receipt receipt={receipt({ checks: [{ kind: 'test', label: 'pytest', ok: true, exitCode: 0, runs: 1 }] })} />)
    expect(container.querySelector('.receipt--failed')).toBeNull()
  })

  it('renders a command as text, never as markup', () => {
    const label = '<img src=x onerror=alert(1)> **bold**'
    const { container } = render(
      <Receipt receipt={receipt({ checks: [{ kind: 'test', label, ok: false, exitCode: 1, runs: 1 }] })} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(screen.getByTitle(label)).toBeInTheDocument()
  })

  it('shows each command without its cd and redirection scaffolding, the full one on hover', () => {
    const label = 'cd /home/me/project/server && PORT=3002 npm run dev 2>&1'
    render(<Receipt receipt={receipt({ checks: [{ kind: 'server', label, ok: null, unknown: 'still-running', background: true, runs: 1 }] })} />)
    const cmd = screen.getByText('PORT=3002 npm run dev')
    expect(cmd).toHaveAttribute('title', label)
    expect(screen.queryByText(/\/home\/me/)).toBeNull()
  })

  it('says how many changed files were left off the list', () => {
    render(<Receipt receipt={receipt({ filesChanged: ['a.py'], filesChangedCount: 3 })} />)
    expect(screen.getByText('And 2 more.')).toBeInTheDocument()
  })
})

describe('Receipt todo gaps', () => {
  it('lists the todos marked done with nothing recorded', () => {
    const { container } = render(<Receipt receipt={receipt({ todoGaps: ['Backend tests with pytest'] })} />)
    fireEvent.click(screen.getByText('What ran'))
    expect(screen.getByText('Marked done with nothing recorded')).toBeInTheDocument()
    expect(screen.getByText('Backend tests with pytest')).toBeInTheDocument()
    expect(container.querySelector('.receipt--failed')).not.toBeNull()
  })
})

describe('Receipt plan progress', () => {
  it("lists the plan's checks and the files it named that no turn has changed", () => {
    render(
      <Receipt
        receipt={receipt({
          plan: {
            title: 'Todo app',
            filesTotal: 3,
            filesPending: ['web/App.jsx'],
            filesPendingCount: 1,
            checks: [{ step: 'pytest', status: 'not-run' }],
            complete: false
          }
        })}
      />
    )
    fireEvent.click(screen.getByText('What ran'))
    expect(screen.getByText('Plan: Todo app')).toBeInTheDocument()
    expect(screen.getByText('not run yet')).toBeInTheDocument()
    expect(screen.getByText('Files not changed yet: web/App.jsx.')).toBeInTheDocument()
  })
})
