/** In-memory stand-in for the settings file, keyed by chat id. */
export function memoryStore(initial = {}) {
  const data = structuredClone(initial)
  const writes = []
  return {
    load: (id) => structuredClone(data[id] ?? {}),
    save: (id, settings) => {
      data[id] = structuredClone(settings)
      writes.push({ id, ...settings })
    },
    writes,
    data
  }
}
