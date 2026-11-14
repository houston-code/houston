import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFolderDrop } from './useFolderDrop'

function dragEvent(type: string, files: File[], target: EventTarget = document.body): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files } })
  Object.defineProperty(e, 'target', { value: target })
  return e
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useFolderDrop', () => {
  const folder = new File([''], 'proj')
  const image = new File([''], 'shot.png', { type: 'image/png' })
  const paths = new Map<File, string>([
    [folder, '/home/me/proj'],
    [image, '/home/me/shot.png']
  ])
  const pathFor = (f: File): string => paths.get(f) ?? ''

  it('shows the hint while files are dragged over the window and opens the drop', () => {
    const open = vi.fn()
    const { result } = renderHook(() => useFolderDrop(open, pathFor))
    act(() => {
      window.dispatchEvent(dragEvent('dragenter', [folder]))
    })
    expect(result.current).toBe(true)
    act(() => {
      window.dispatchEvent(dragEvent('drop', [folder]))
    })
    expect(result.current).toBe(false)
    expect(open).toHaveBeenCalledWith(['/home/me/proj'])
  })

  it('hides the hint when the drag leaves the window', () => {
    const { result } = renderHook(() => useFolderDrop(vi.fn(), pathFor))
    act(() => {
      window.dispatchEvent(dragEvent('dragenter', [folder]))
      window.dispatchEvent(dragEvent('dragleave', [folder]))
    })
    expect(result.current).toBe(false)
  })

  it('leaves images dropped on the composer to the composer', () => {
    const card = document.createElement('div')
    card.className = 'composer__card'
    const inner = document.createElement('textarea')
    card.appendChild(inner)
    document.body.appendChild(card)
    const open = vi.fn()
    const { result } = renderHook(() => useFolderDrop(open, pathFor))
    act(() => {
      window.dispatchEvent(dragEvent('dragenter', [image], inner))
    })
    expect(result.current).toBe(false)
    act(() => {
      window.dispatchEvent(dragEvent('drop', [image], inner))
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves a folder or any other file dropped on the composer to the composer', () => {
    // The composer attaches files and explains that a folder can't be attached; opening
    // it as the project as well handled the one drop twice.
    const card = document.createElement('div')
    card.className = 'composer__card'
    document.body.appendChild(card)
    const notes = new File(['# notes'], 'notes.md', { type: 'text/markdown' })
    const open = vi.fn()
    renderHook(() => useFolderDrop(open, (f) => (f === notes ? '/home/me/notes.md' : pathFor(f))))
    act(() => {
      window.dispatchEvent(dragEvent('drop', [folder], card))
      window.dispatchEvent(dragEvent('drop', [notes], card))
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('still opens a folder dropped outside the composer', () => {
    const card = document.createElement('div')
    card.className = 'composer__card'
    document.body.appendChild(card)
    const open = vi.fn()
    renderHook(() => useFolderDrop(open, pathFor))
    act(() => {
      window.dispatchEvent(dragEvent('drop', [folder], document.body))
    })
    expect(open).toHaveBeenCalledWith(['/home/me/proj'])
  })

  it('ignores drags without files, like a sidebar row or selected text', () => {
    const open = vi.fn()
    const { result } = renderHook(() => useFolderDrop(open, pathFor))
    const e = new Event('drop', { bubbles: true })
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['text/plain'], files: [] } })
    act(() => {
      window.dispatchEvent(e)
    })
    expect(result.current).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
