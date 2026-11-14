import { createElement, type ComponentType } from 'react'

/**
 * A stand-in for `Component` that counts its renders under `name` (for tests that
 * assert what a change re-renders). It renders `Component` with the same props, so
 * behavior is unchanged; wrap it wherever the real component is imported.
 */
export function counted<P extends object>(
  renders: Map<string, number>,
  name: string,
  Component: ComponentType<P>
): ComponentType<P> {
  function Counted(props: P): JSX.Element {
    renders.set(name, (renders.get(name) ?? 0) + 1)
    return createElement(Component, props)
  }
  Counted.displayName = name
  return Counted
}
