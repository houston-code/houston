import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ShareButton } from './ShareButton'

function installApi(result: 'sheet' | 'copied') {
  const shareHouston = vi.fn().mockResolvedValue(result)
  const shareVia = vi.fn().mockResolvedValue(true)
  window.api = { shareHouston, shareVia } as unknown as typeof window.api
  return { shareHouston, shareVia }
}

describe('ShareButton', () => {
  it('shares in one click, anchoring the sheet at the button', async () => {
    const api = installApi('sheet')
    render(<ShareButton />)
    fireEvent.click(screen.getByRole('button', { name: /share houston/i }))
    await waitFor(() => expect(api.shareHouston).toHaveBeenCalledTimes(1))
    expect(api.shareHouston.mock.calls[0][0]).toEqual({ x: expect.any(Number), y: expect.any(Number) })
    // The OS sheet handled it: no in-app popover.
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers a Copy invite item when there is no share sheet', async () => {
    const api = installApi('copied')
    render(<ShareButton />)
    fireEvent.click(screen.getByRole('button', { name: /share houston/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /copy invite/i }))
    expect(api.shareVia).toHaveBeenCalledWith('copy')
  })

  it('confirms the copy and offers email when there is no share sheet', async () => {
    const api = installApi('copied')
    render(<ShareButton />)
    fireEvent.click(screen.getByRole('button', { name: /share houston/i }))
    expect(await screen.findByText(/invite copied/i)).toBeTruthy()
    expect(screen.queryByText(/whatsapp/i)).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /send by email/i }))
    expect(api.shareVia).toHaveBeenCalledWith('email')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('has an icon-only rail variant with an accessible name', () => {
    installApi('sheet')
    render(<ShareButton variant="rail" />)
    expect(screen.getByRole('button', { name: 'Share Houston' })).toBeTruthy()
  })
})
