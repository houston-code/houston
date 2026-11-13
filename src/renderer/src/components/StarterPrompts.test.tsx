import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { starterPrompts } from '@shared/onboarding'
import { StarterPrompts } from './StarterPrompts'

describe('StarterPrompts', () => {
  it('shows one chip per task, with the full task as its tooltip', () => {
    const prompts = starterPrompts('has-files')
    render(<StarterPrompts prompts={prompts} onPick={vi.fn()} />)
    const list = screen.getByRole('region', { name: 'Starter tasks' })
    const chips = within(list).getAllByRole('button')
    expect(chips.map((c) => c.textContent)).toEqual(prompts.map((p) => p.label))
    expect(chips[1]).toHaveAttribute('title', prompts[1].task)
  })

  it('hands the full task over when a chip is clicked', () => {
    const onPick = vi.fn()
    render(<StarterPrompts prompts={starterPrompts('empty')} onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Make a landing page' }))
    expect(onPick).toHaveBeenCalledExactlyOnceWith(
      'Make a one-page landing site for a neighborhood coffee shop, in plain HTML and CSS.'
    )
  })

  it('renders nothing with no tasks', () => {
    const { container } = render(<StarterPrompts prompts={[]} onPick={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
