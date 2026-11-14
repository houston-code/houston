// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: () => ({}) } }))

const { SNAPSHOT_SCRIPT, MAX_SNAPSHOT_NODES } = await import('./localhostCapture')

/** Run the page-side snapshot script against the current jsdom document. */
const snapshot = (): string => (0, eval)(SNAPSHOT_SCRIPT) as string

describe('the accessibility snapshot script', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('lists roles, names, and states as an indented tree with refs', () => {
    document.body.innerHTML = `
      <main>
        <h1>Todos</h1>
        <form>
          <label for="new">New todo</label><input id="new" value="milk">
          <input type="password" aria-label="Password" value="hunter2">
          <input type="checkbox" aria-label="Done" checked>
          <button disabled>Add</button>
        </form>
        <ul><li>Eggs <a href="/eggs">open</a></li></ul>
      </main>`
    const out = snapshot()
    expect(out).toBe(
      [
        '- main [ref=e1]',
        '  - heading "Todos" [level=1] [ref=e2]',
        '  - form [ref=e3]',
        '    - text "New todo"',
        '    - textbox "New todo" [value="milk"] [ref=e4]',
        '    - textbox "Password" [filled] [ref=e5]',
        '    - checkbox "Done" [checked] [ref=e6]',
        '    - button "Add" [disabled] [ref=e7]',
        '  - list [ref=e8]',
        '    - listitem [ref=e9]',
        '      - text "Eggs"',
        '      - link "open" [url="/eggs"] [ref=e10]'
      ].join('\n')
    )
    expect(out).not.toContain('hunter2')
  })

  it('keeps an element ref stable across snapshots and numbers new elements after it', () => {
    document.body.innerHTML = '<button id="a">A</button>'
    expect(snapshot()).toBe('- button "A" [ref=e1]')
    const b = document.createElement('button')
    b.textContent = 'B'
    document.body.prepend(b)
    expect(snapshot()).toBe('- button "B" [ref=e2]\n- button "A" [ref=e1]')
    expect(document.querySelector('[data-houston-ref="e1"]')!.id).toBe('a')
  })

  it('gives a copied element its own ref instead of sharing one', () => {
    document.body.innerHTML = '<button>A</button>'
    snapshot()
    document.body.append(document.querySelector('button')!.cloneNode(true))
    expect(snapshot()).toBe('- button "A" [ref=e1]\n- button "A" [ref=e2]')
  })

  it('skips hidden content, scripts, and hidden inputs', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><button>Ghost</button></div><script>var x = 1</script><input type="hidden" value="t"><p>Shown</p>'
    expect(snapshot()).toBe('- text "Shown"')
  })

  it('caps how many nodes it lists', () => {
    document.body.innerHTML = Array.from({ length: MAX_SNAPSHOT_NODES + 5 }, (_, i) => `<button>${i}</button>`).join('')
    const lines = snapshot().split('\n')
    expect(lines).toHaveLength(MAX_SNAPSHOT_NODES + 1)
    expect(lines.at(-1)).toBe('- ... 5 more node(s) not shown')
  })
})
