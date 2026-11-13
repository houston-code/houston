import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBarInfo } from './StatusBarInfo'

describe('StatusBarInfo', () => {
  it('shows the branch and the approval mode', () => {
    render(<StatusBarInfo branch="feature/login" policy="full-auto" />)
    expect(screen.getByText('feature/login')).toBeInTheDocument()
    expect(screen.getByTitle('Git branch: feature/login')).toBeInTheDocument()
    expect(screen.getByText('Full auto')).toBeInTheDocument()
  })

  it('says so when a repo has no branch checked out', () => {
    render(<StatusBarInfo branch={null} policy="ask" />)
    expect(screen.getByText('No branch')).toBeInTheDocument()
  })

  it('shows neither outside a repo and with no chat to run', () => {
    const { container } = render(<StatusBarInfo branch={undefined} policy={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
