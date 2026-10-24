/**
 * In-memory document store standing in for the real one, with the same async
 * shape: every call completes on a later tick. Records are copied in and out so
 * callers can't mutate what's stored.
 *
 * `failOn` makes reads of the listed ids fail, to exercise error paths.
 */
export function createDb({ failOn = [] } = {}) {
  const records = new Map()
  const later = (fn) => setImmediate(fn)
  const copy = (r) => (r === undefined ? undefined : structuredClone(r))

  return {
    get(id, cb) {
      later(() => {
        if (failOn.includes(id)) return cb(new Error(`read failed for ${id}`))
        cb(null, copy(records.get(id)))
      })
    },
    put(record, cb) {
      later(() => {
        if (!record || !record.id) return cb(new Error('id required'))
        records.set(record.id, copy(record))
        cb(null)
      })
    },
    remove(id, cb) {
      later(() => cb(null, records.delete(id)))
    },
    ids(cb) {
      later(() => cb(null, [...records.keys()]))
    }
  }
}
