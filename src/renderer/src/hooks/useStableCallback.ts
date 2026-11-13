import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A callback whose identity never changes but which always calls the latest `fn`.
 *
 * For handing a handler to memoized children when the parent re-creates that handler
 * on every render (an inline arrow, a callback with unstable dependencies): the child
 * sees the same prop and skips its render, and a click still runs the current logic.
 * Only for event handlers, which run after render; the latest `fn` is installed in a
 * layout effect, so calling the result during render would see the previous one.
 *
 * `undefined` passes through, so "this handler is absent" still reaches the child.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined
): ((...args: A) => R) | undefined
export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined
): ((...args: A) => R) | undefined {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  const stable = useCallback((...args: A): R => (latest.current as (...a: A) => R)(...args), [])
  return fn ? stable : undefined
}
