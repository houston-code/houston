import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectCard } from './ProjectCard'

describe('ProjectCard', () => {
  it('names the project, its branch and its stack', () => {
    render(<ProjectCard name="demo-app" branch="main" facts={{ stack: ['Node.js', 'TypeScript'], instructions: null }} />)
    expect(screen.getByRole('region', { name: 'Project' })).toHaveTextContent(
      'demo-app · on main · Node.js, TypeScript'
    )
  })

  it('says which instructions file is read every run, with nothing to generate', () => {
    render(<ProjectCard name="api" facts={{ stack: [], instructions: 'CLAUDE.md' }} onGenerate={vi.fn()} />)
    expect(screen.getByText(/at the start of every run/)).toHaveTextContent('Houston reads CLAUDE.md')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers /init when there is no instructions file', () => {
    const onGenerate = vi.fn()
    render(<ProjectCard name="api" facts={{ stack: ['Go'], instructions: null }} onGenerate={onGenerate} />)
    expect(screen.getByText(/No/)).toHaveTextContent('No AGENTS.md yet')
    fireEvent.click(screen.getByRole('button', { name: 'Write one with /init' }))
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('leaves out the button when there is nothing to run it with', () => {
    render(<ProjectCard name="api" facts={{ stack: [], instructions: null }} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
