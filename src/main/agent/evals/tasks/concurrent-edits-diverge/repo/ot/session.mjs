import { apply, applyAll } from './ops.mjs'
import { transform } from './transform.mjs'

/**
 * Two sites editing one document concurrently: each applies its own op, then the
 * other's op transformed against it. Returns what each screen shows.
 */
export function editConcurrently(doc, opA, opB) {
  return {
    a: applyAll(apply(doc, opA), transform(opB, opA)),
    b: applyAll(apply(doc, opB), transform(opA, opB))
  }
}
