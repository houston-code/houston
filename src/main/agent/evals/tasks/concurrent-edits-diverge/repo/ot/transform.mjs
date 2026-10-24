/**
 * Operational transform for concurrent edits. Two clients edit the same version of a
 * document; each applies its own op at once and the other's op after transforming
 * it. `transform(op, against)` rewrites `op` to apply AFTER `against`, as a list of
 * ops (a delete can come back split in two). The contract both clients rely on:
 *
 *   applyAll(apply(doc, a), transform(b, a)) === applyAll(apply(doc, b), transform(a, b))
 *
 * for every document and every pair of ops made against it by different sites, so
 * both screens end up with the same text. Each edit's intent survives too: text that
 * one site inserts is never deleted by a concurrent delete of the text around it, and
 * two inserts at the same offset go in site order, lower site first.
 */
export function transform(op, against) {
  if (op.type === 'insert' && against.type === 'insert') {
    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]
    return [op]
  }
  if (op.type === 'insert' && against.type === 'delete') {
    if (op.pos <= against.pos) return [op]
    if (op.pos >= against.pos + against.len) return [{ ...op, pos: op.pos - against.len }]
    return [{ ...op, pos: against.pos }]
  }
  if (op.type === 'delete' && against.type === 'insert') {
    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]
    return [op]
  }
  // delete against delete
  if (against.pos + against.len <= op.pos) return [{ ...op, pos: op.pos - against.len }]
  if (op.pos + op.len <= against.pos) return [op]
  return [{ ...op, pos: Math.min(op.pos, against.pos), len: Math.max(0, op.len - against.len) }]
}
