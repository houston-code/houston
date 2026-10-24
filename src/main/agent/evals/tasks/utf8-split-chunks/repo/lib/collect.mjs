/** Read a child's whole output stream into one string. */
export async function collect(stream) {
  let out = ''
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }
  return out
}
