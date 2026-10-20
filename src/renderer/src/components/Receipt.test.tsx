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
  it('shows one summary line that names Houston as its author, collapsed', () => {
    const { container } = render(<Receipt receipt={receipt()} />)
    expect(screen.getByText('Recorded by Houston')).toBeInTheDocument()
    expect(screen.getByText('No tests ran · install failed (no network) · server started · 2 files changed')).toBeInTheDocument()
    expect(container.querySelector('details')?.open).toBe(false)
  })

  it('expands to each check, the commands not listed, and the files changed', () => {
    const { container } = render(<Receipt receipt={receipt()} />)
    fireEvent.click(screen.getByText('Recorded by Houston'))
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
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('says how many changed files were left off the list', () => {
    render(<Receipt receipt={receipt({ filesChanged: ['a.py'], filesChangedCount: 3 })} />)
    expect(screen.getByText('And 2 more.')).toBeInTheDocument()
  })
})
