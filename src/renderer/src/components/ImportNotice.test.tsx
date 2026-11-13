import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportNotice } from './ImportNotice'

afterEach(cleanup)

function installApi(offer: boolean) {
  const getImportOffer = vi.fn(() => Promise.resolve(offer))
  const answerImportOffer = vi.fn(() => Promise.resolve())
  window.api = { getImportOffer, answerImportOffer } as unknown as typeof window.api
  return { getImportOffer, answerImportOffer }
}

describe('ImportNotice', () => {
  it('stays hidden when there is nothing to offer', async () => {
    const api = installApi(false)
    const { container } = render(<ImportNotice workspace="/w" onReview={vi.fn()} />)
    await waitFor(() => expect(api.getImportOffer).toHaveBeenCalledWith('/w'))
    expect(container.textContent).toBe('')
  })

  it('Review records the answer and opens Settings', async () => {
    const api = installApi(true)
    const onReview = vi.fn()
    render(<ImportNotice workspace={null} onReview={onReview} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
    expect(api.answerImportOffer).toHaveBeenCalledOnce()
    expect(onReview).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('Not now records the answer without opening anything', async () => {
    const api = installApi(true)
    const onReview = vi.fn()
    render(<ImportNotice workspace={null} onReview={onReview} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(api.answerImportOffer).toHaveBeenCalledOnce()
    expect(onReview).not.toHaveBeenCalled()
  })
})
