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

  // Esc is deliberately NOT handled here: it's owned by App's global key handler,
  // which knows the modal is open and suppresses run-cancel/cycle-mode while it is.
  // A private Esc listener here fired first and let App's handler fall through to
  // cancel a running turn (the bug this modal's Esc handling was removed to fix).
  it('does not register its own Escape listener', async () => {
    installApi(facts())
    const onClose = vi.fn()
    render(<DoctorModal workspace={null} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Everything looks healthy.')).toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
