import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorModal } from './DoctorModal'
import type { DoctorFacts } from '@shared/doctor'

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    version: '0.2.200',
    nodeVersion: 'v22.11.0',
    platform: 'darwin arm64',
    cwd: '/work/proj',
    settingsPath: '/data/settings.json',
    sandbox: { backend: 'seatbelt', enforced: true },
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true }],
    active: { providerId: 'anthropic', model: 'claude' },
    mcp: [],
    binaries: [{ name: 'git', path: '/usr/bin/git', purpose: 'the git tools' }],
    update: null,
    ...over
  }
}

function installApi(f: DoctorFacts): ReturnType<typeof vi.fn> {
  const getDoctorFacts = vi.fn((_ws: string) => Promise.resolve(f))
  window.api = { getDoctorFacts } as unknown as typeof window.api
  return getDoctorFacts
}

afterEach(() => vi.restoreAllMocks())

describe('DoctorModal', () => {
  it('gathers facts for the workspace and shows a healthy verdict', async () => {
    const api = installApi(facts())
    render(<DoctorModal workspace="/work/proj" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Everything looks healthy.')).toBeInTheDocument())
    expect(api).toHaveBeenCalledWith('/work/proj')
    // The desktop report has no Terminal group.
    expect(screen.queryByText('Terminal')).toBeNull()
    expect(screen.getByText('Sandbox')).toBeInTheDocument()
  })

  it('surfaces a problem and its fix', async () => {
    installApi(
      facts({
        providers: [{ id: 'openai', requiresKey: true, hasKey: false }],
        active: null
      })
    )
    render(<DoctorModal workspace={null} onClose={vi.fn()} />)
    // A provider with no key is a warning that names the fix; no active model is a fail.
    await waitFor(() => expect(screen.getByText(/problem/)).toBeInTheDocument())
    expect(screen.getByText(/run \/login and pick openai/)).toBeInTheDocument()
  })

  it('counts an env var shadowing a stored key as a warning', async () => {
    installApi(
      facts({
        providers: [{ id: 'anthropic', requiresKey: true, hasKey: true, shadowedByEnv: 'ANTHROPIC_API_KEY' }]
      })
    )
    render(<DoctorModal workspace={null} onClose={vi.fn()} />)
    // The env var appears in both the detail and its fix — that it's surfaced at all
    // is the point (it's the cause of "I changed my key and nothing happened").
    await waitFor(() => expect(screen.getAllByText(/ANTHROPIC_API_KEY/).length).toBeGreaterThan(0))
    expect(screen.getByText(/unset ANTHROPIC_API_KEY/)).toBeInTheDocument()
    expect(screen.getByText(/worth knowing/)).toBeInTheDocument()
  })

  it('closes on the button and the backdrop', async () => {
    installApi(facts())
    const onClose = vi.fn()
    const { container } = render(<DoctorModal workspace={null} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Everything looks healthy.')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Close doctor' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(container.querySelector('.modal-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  // No document-level Esc listener: one here once fired first and let App's handler
  // fall through to cancel a running turn. Esc is handled by the focus trap on the
  // dialog itself, which stops it there (next test).
  it('does not register its own Escape listener', async () => {
    installApi(facts())
    const onClose = vi.fn()
    render(<DoctorModal workspace={null} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Everything looks healthy.')).toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('takes focus on open and closes on Esc without letting it reach the app', async () => {
    installApi(facts())
    const onClose = vi.fn()
    const appHandler = vi.fn()
    window.addEventListener('keydown', appHandler)
    try {
      render(<DoctorModal workspace={null} onClose={onClose} />)
      const dialog = screen.getByRole('dialog')
      expect(dialog.contains(document.activeElement)).toBe(true)
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      // App's global handler would read a stray Esc as "stop the running turn".
      expect(appHandler).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', appHandler)
    }
  })
})
