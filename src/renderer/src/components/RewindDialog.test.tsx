import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RewindPreviewResult } from '@shared/rewind'
import { RewindDialog } from './RewindDialog'

const target = { turn: 2, text: 'make the tests pass', label: 'make the tests pass' }
let previewRewind: ReturnType<typeof vi.fn>

beforeEach(() => {
  previewRewind = vi.fn(
    async (_c: string, _t: number, mode: string): Promise<RewindPreviewResult> => ({
      ok: true,
      turns: mode === 'code' ? 0 : 3,
      files: mode === 'conversation' ? 0 : 2,
      conflicts: mode === 'conversation' ? [] : ['src/a.ts'],
      unavailable: 0
    })
  )
  window.api = { previewRewind } as unknown as typeof window.api
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('RewindDialog', () => {
  it('previews the chosen mode: messages, files, conflicts, and the shell caveat', async () => {
    render(<RewindDialog conversationId="c1" target={target} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(previewRewind).toHaveBeenCalledWith('c1', 2, 'both', 'make the tests pass')
    const status = await screen.findByRole('status')
    await waitFor(() => expect(status.textContent).toContain('Removes 3 messages'))
    expect(status.textContent).toContain('Restores 2 files')
    expect(status.textContent).toContain('src/a.ts')
    expect(status.textContent).toContain("shell commands aren't tracked")
    expect(status.textContent).not.toContain('—')
  })

  it('re-previews when the mode changes, and confirms with the chosen mode', async () => {
    const onConfirm = vi.fn()
    render(<RewindDialog conversationId="c1" target={target} onCancel={vi.fn()} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('radio', { name: /Conversation only/ }))
    await waitFor(() => expect(previewRewind).toHaveBeenLastCalledWith('c1', 2, 'conversation', target.text))
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('Restores'))
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    expect(onConfirm).toHaveBeenCalledWith('conversation')
  })

  it('starts on the mode picked from the menu', async () => {
    render(
      <RewindDialog conversationId="c1" target={target} initialMode="code" onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    expect((screen.getByRole('radio', { name: /Code only/ }) as HTMLInputElement).checked).toBe(true)
    expect(previewRewind).toHaveBeenCalledWith('c1', 2, 'code', target.text)
  })

  it('shows a refusal and keeps Rewind disabled', async () => {
    previewRewind.mockResolvedValue({ ok: false, error: 'Stop the running turn before rewinding.' })
    const onConfirm = vi.fn()
    render(<RewindDialog conversationId="c1" target={target} onCancel={vi.fn()} onConfirm={onConfirm} />)
    await screen.findByText('Stop the running turn before rewinding.')
    const btn = screen.getByRole('button', { name: 'Rewind' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('cancels with the button or Escape, and offers edit and resend', async () => {
    const onCancel = vi.fn()
    const onEdit = vi.fn()
    render(<RewindDialog conversationId="c1" target={target} onCancel={onCancel} onConfirm={vi.fn()} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    expect(onEdit).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
