/**
 * Motion that script starts itself. CSS animations already stand down under the
 * `prefers-reduced-motion: reduce` rules in global.css, but a `scrollTo` or
 * `scrollIntoView` asked for with `behavior: 'smooth'` animates regardless, so every
 * scripted scroll asks here first.
 */

/** Whether the user asked the system for less motion. False where it can't be read. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  } catch {
    return false
  }
}

/** The scroll behavior to ask for: smooth, unless reduced motion is on (then an instant jump). */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
