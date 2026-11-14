import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PathLabel, splitPath } from './PathLabel'

describe('PathLabel', () => {
  it('splits a path into its folder and file name', () => {
    expect(splitPath('src/renderer/App.tsx')).toEqual({ dir: 'src/renderer/', base: 'App.tsx' })
    expect(splitPath('README.md')).toEqual({ dir: '', base: 'README.md' })
  })

  it('keeps the file name in its own span, so only the folder is cut short', () => {
    const { container } = render(<PathLabel path="src/renderer/App.tsx" />)
    const label = container.firstElementChild as HTMLElement
    expect(label).toHaveTextContent('src/renderer/App.tsx')
    expect(label).toHaveAttribute('title', 'src/renderer/App.tsx')
    expect(label.querySelector('.path-label__dir')).toHaveTextContent('src/renderer/')
    expect(label.querySelector('.path-label__base')).toHaveTextContent('App.tsx')
  })

  it('shows a rename as old then new', () => {
    const { container } = render(<PathLabel path="lib/b.ts" oldPath="lib/a.ts" />)
    const label = container.firstElementChild as HTMLElement
    expect(label).toHaveTextContent('lib/a.ts → lib/b.ts')
    expect(label.querySelector('.path-label__base')).toHaveTextContent('b.ts')
    expect(label).toHaveAttribute('title', 'lib/a.ts → lib/b.ts')
  })
})
