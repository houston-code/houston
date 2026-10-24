/** The clock notes are stamped with. Tests pin it. */
let current = () => new Date().toISOString()

export function now() {
  return current()
}

export function setClock(fn) {
  current = fn
}
