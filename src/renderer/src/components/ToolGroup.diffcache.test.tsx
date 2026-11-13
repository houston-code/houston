import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolItem } from '../lib/items'

const h = vi.hoisted(() => ({ diffLines: vi.fn() }))
vi.mock('@shared/diff', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shared/diff')>()
  h.diffLines.mockImplementation(real.diffLines)
  return { ...real, diffLines: h.diffLines }
})

import { ToolGroup } from './ToolGroup'

/** A row as a reopened chat rebuilds it: arguments, no preview shipped by main. */
const edit = (id: string): ToolItem => ({
  kind: 'tool',
  id,
  name: 'edit_file',
  status: 'done',
  args: { path: 'src/a.ts', old_string: 'one\ntwo', new_string: 'one\n2' }
})

describe('fallback diff of a row without a preview', () => {
  it('is computed once per row, however often the transcript re-renders', () => {
    const items = [edit('a'), edit('b')]
    const { container, rerender } = render(<ToolGroup items={items} onApprove={vi.fn()} />)
    expect(container.textContent).toContain('+1')
    expect(h.diffLines).toHaveBeenCalledTimes(2)
    // A streamed token re-renders the group with the same item objects.
    for (let i = 0; i < 5; i++) rerender(<ToolGroup items={[...items]} onApprove={vi.fn()} />)
    expect(h.diffLines).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('+1')
  })
})
