import { createElement, memo, useRef, type ComponentType, type FunctionComponent } from 'react'

type AnyFn = (...args: unknown[]) => unknown

/**
 * `memo` for a pane that App renders on every agent event (the sidebar, the title bar,
 * the composer, the dock's panels), made to hold against the handlers App passes it.
 *
 * App is where the open chat's state lives, so every streamed delta renders it, and
 * many of its handlers are rebuilt each time (they close over the chat). A plain `memo`
 * would see new functions on every delta and render the pane anyway. This passes each
 * function prop on as a wrapper that keeps one identity for the life of the pane and
 * calls the newest function given, so the pane renders only when something it shows
 * changes. A handler appearing or going away still counts as a change.
 *
 * Every other prop is compared by identity, as `memo` does: objects and arrays built
 * inline in App's render need a `useMemo` (or a shared constant) to keep the pane still.
 */
export function memoPane<P extends object>(Component: ComponentType<P>): FunctionComponent<P> {
  const Inner = memo(Component) as unknown as ComponentType<Record<string, unknown>>
  function Pane(props: P): JSX.Element {
    // Updated as the pane renders, not in an effect, so a prop the pane calls while it
    // renders is the one just passed.
    const latest = useRef(props as Record<string, unknown>)
    latest.current = props as Record<string, unknown>
    const wrappers = useRef(new Map<string, AnyFn>())
    const passed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(props)) {
      if (typeof value !== 'function') {
        passed[key] = value
        continue
      }
      let wrapper = wrappers.current.get(key)
      if (!wrapper) {
        wrapper = (...args) => {
          const fn = latest.current[key]
          return typeof fn === 'function' ? (fn as AnyFn)(...args) : undefined
        }
        wrappers.current.set(key, wrapper)
      }
      passed[key] = wrapper
    }
    return createElement(Inner, passed)
  }
  Pane.displayName = `Pane(${Component.displayName ?? Component.name ?? 'Component'})`
  return Pane
}
