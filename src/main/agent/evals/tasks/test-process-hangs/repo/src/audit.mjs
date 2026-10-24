/**
 * Audit entries are batched: the first write in a quiet period schedules a flush,
 * so a burst of requests becomes one write to the sink. `flush()` writes whatever is
 * pending right away.
 */
export function createAuditLog(sink, { batchMs = 30_000 } = {}) {
  let pending = []
  let timer = null

  function flush() {
    if (!pending.length) return
    sink.write(pending)
    pending = []
  }

  return {
    record(entry) {
      pending.push(entry)
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          flush()
        }, batchMs)
      }
    },
    flush
  }
}
