import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IssueReportModal } from './IssueReportModal'

function installApi(getIssueReport = vi.fn(() => Promise.resolve('### What happened?\n\n- Houston 1.2.3'))) {
  const api = { getIssueReport, openIssueReport: vi.fn(() => Promise.resolve(true)) }
  window.api = api as unknown as typeof window.api
  return api
}

describe('IssueReportModal', () => {
  it('shows exactly what the issue will start with before opening anything', async () => {
    const api = installApi()
    render(<IssueReportModal onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Report an issue' })).toHaveTextContent('no logs, file paths, or keys')
    const preview = await screen.findByLabelText('Text the issue will start with')
    await waitFor(() => expect(preview).toHaveTextContent('Houston 1.2.3'))
    expect(api.openIssueReport).not.toHaveBeenCalled()
  })

  it('opens GitHub on the user’s say-so, then closes', async () => {
    const api = installApi()
    const onClose = vi.fn()
    render(<IssueReportModal onClose={onClose} />)
    const open = screen.getByRole('button', { name: 'Open GitHub' })
    await waitFor(() => expect(open).toBeEnabled())
    fireEvent.click(open)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.openIssueReport).toHaveBeenCalledTimes(1)
  })

  it('closes on Cancel without opening anything', () => {
    const api = installApi()
    const onClose = vi.fn()
    render(<IssueReportModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(api.openIssueReport).not.toHaveBeenCalled()
  })

  it('still offers a blank issue when the diagnostics fail', async () => {
    installApi(vi.fn(() => Promise.reject(new Error('boom'))))
    render(<IssueReportModal onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('blank issue')
    expect(screen.getByRole('button', { name: 'Open GitHub' })).toBeEnabled()
  })
})
