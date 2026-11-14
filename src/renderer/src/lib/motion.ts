/**
 * The scroll behavior for a script-driven scroll. An explicit `behavior: 'smooth'`
 * in `scrollTo` / `scrollIntoView` overrides the CSS `scroll-behavior` that the
 * global reduced-motion rule sets, so a smooth jump would still animate for someone
 * who asked their OS to reduce motion. Ask for it through here instead: it is
 * 'auto' (an instant jump) when the OS prefers reduced motion, else 'smooth'.
 */
export function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return reduce ? 'auto' : 'smooth'
}
