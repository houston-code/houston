export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/**
 * Whether the viewport is close enough to the bottom that we should keep it
 * pinned there as new content streams in. A small threshold absorbs sub-pixel
 * rounding and treats "almost at the bottom" as pinned, so a single wheel tick
 * doesn't unstick the transcript. When the user scrolls further up than the
 * threshold this returns false, and streaming output no longer yanks the view.
 */
export function isNearBottom({ scrollHeight, scrollTop, clientHeight }: ScrollMetrics, threshold = 80): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}
