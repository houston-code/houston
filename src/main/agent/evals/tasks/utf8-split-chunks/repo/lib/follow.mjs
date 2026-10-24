/**
 * Call `onLine` for each complete line as it arrives, so a long build can be shown
 * live. A final line with no trailing newline is delivered when the stream ends.
 */
export async function followLines(stream, onLine) {
  let pending = ''
  for await (const chunk of stream) {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl
    while ((nl = pending.indexOf('\n')) !== -1) {
      onLine(pending.slice(0, nl).replace(/\r$/, ''))
      pending = pending.slice(nl + 1)
    }
  }
  if (pending) onLine(pending.replace(/\r$/, ''))
}
