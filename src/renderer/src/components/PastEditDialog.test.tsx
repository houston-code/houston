import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DisplayItem, ToolItem } from '../lib/items'
import { PastEditDialog, pastEdits } from './PastEditDialog'

function edit(id: string, path: string, over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool',
    id,
    name: 'edit_file',
    toolKind: 'write',
    status: 'done',
    preview: [{ path, diff: [{ type: 'del', text: `old ${path}` }, { type: 'add', text: `new ${path}` }] }],
    ...over
  } as ToolItem
}

describe('pastEdits', () => {
  it("lists the chat's finished edits oldest first, skipping reads, failures and empty diffs", () => {
    const items: DisplayItem[] = [
      { kind: 'user', id: 'u', text: 'go' } as DisplayItem,
      edit('a', 'a.ts'),
      { kind: 'tool', id: 'r', name: 'read_file', toolKind: 'read', status: 'done' } as DisplayItem,
      edit('b', 'b.ts', { status: 'error' }),
      edit('c', 'c.ts', { status: 'denied' }),
      edit('d', 'd.ts', { preview: [{ path: 'd.ts', diff: [] }] }),
      edit('e', 'e.ts')
    ]
    expect(pastEdits(items).map((e) => e.item.id)).toEqual(['a', 'e'])
  })

  it('falls back to the diff the row works out from its arguments', () => {
    const row = edit('f', 'f.ts', {
      preview: undefined,
      args: { path: 'f.ts', old_string: 'x', new_string: 'y' }
    })
    const [only] = pastEdits([row])
    expect(only.previews[0].path).toBe('f.ts')
    expect(only.previews[0].diff.length).toBeGreaterThan(0)
  })
})

describe('PastEditDialog', () => {
  it("shows the edit's files and diff, and closes", () => {
    const onClose = vi.fn()
    const [e] = pastEdits([edit('a', 'src/a.ts')])
    render(<PastEditDialog edit={e} back={2} onClose={onClose} />)
    expect(screen.getByRole('heading').textContent).toBe('Edit 2 back')
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('new src/a.ts')
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('names the latest edit as such', () => {
    const [e] = pastEdits([edit('a', 'a.ts')])
    render(<PastEditDialog edit={e} back={1} onClose={vi.fn()} />)
    expect(screen.getByRole('heading').textContent).toBe('Latest edit')
  })
})
