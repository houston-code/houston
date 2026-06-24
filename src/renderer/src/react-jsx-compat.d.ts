// React 19 removed the global `JSX` namespace — it now lives under `React.JSX`.
// Several renderer components annotate return types as `JSX.Element` (and one uses
// `keyof JSX.IntrinsicElements`). Bridge the global namespace back to React's so
// those keep resolving without editing every component. Drop this shim if those
// sites are ever migrated to `import { JSX } from 'react'`.
import type { JSX as ReactJSX } from 'react'

declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementType = ReactJSX.ElementType
    type ElementClass = ReactJSX.ElementClass
    type ElementAttributesProperty = ReactJSX.ElementAttributesProperty
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute
    type IntrinsicAttributes = ReactJSX.IntrinsicAttributes
    type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>
    type IntrinsicElements = ReactJSX.IntrinsicElements
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>
  }
}
