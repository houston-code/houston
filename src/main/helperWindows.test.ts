import { describe, expect, it, vi } from 'vitest'

const windows: Array<{ id: number; destroyed: boolean; isDestroyed: () => boolean; destroy: () => void }> = []
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => windows.filter((w) => !w.destroyed) } }))

const { appWindows, destroyHelperWindows, markHelperWindow } = await import('./helperWindows')

function win(id: number) {
  const w = {
    id,
    destroyed: false,
    isDestroyed: () => w.destroyed,
    destroy: () => {
      w.destroyed = true
    }
  }
  windows.push(w)
  return w
}

describe('helper windows', () => {
  it('leaves hidden helpers out of the app windows, and closes only them', () => {
    const main = win(1)
    const mermaid = win(2)
    const capture = win(3)
    markHelperWindow(mermaid as never)
    markHelperWindow(capture as never)
    expect(appWindows().map((w) => w.id)).toEqual([1])
    destroyHelperWindows()
    expect(mermaid.destroyed && capture.destroyed).toBe(true)
    expect(main.destroyed).toBe(false)
  })

  it('reports no app windows when only a helper is left, so the dock icon reopens the app', () => {
    windows.length = 0
    markHelperWindow(win(4) as never)
    expect(appWindows()).toHaveLength(0)
  })
})
