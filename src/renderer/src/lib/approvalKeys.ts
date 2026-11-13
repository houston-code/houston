import type { ToolApprovalDecision } from '@shared/agent'

/**
 * Single-key answers on a tool approval prompt. The standard prompt offers all
 * three; the "allow this host / allow network for this chat" prompts have one allow
 * (which is `always`, for the chat) and no separate run-wide grant, so there Y
 * answers with that allow and A does nothing.
 */
export type ApprovalVariant = 'standard' | 'chat-grant'

export function approvalKeyDecision(key: string, variant: ApprovalVariant): ToolApprovalDecision | null {
  const k = key.toLowerCase()
  if (k === 'n') return 'deny'
  if (variant === 'chat-grant') return k === 'y' ? 'always' : null
  if (k === 'y') return 'allow'
  if (k === 'a') return 'always'
  return null
}

/** Whether the element takes typed text, so a letter key there is typing, not a shortcut. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color'].includes(type)
}

/** Whether a keydown can be an approval key at all, before mapping it. */
export function isApprovalKeyEvent(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'repeat' | 'defaultPrevented'>
): boolean {
  if (e.defaultPrevented || e.repeat) return false
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  return e.key.length === 1
}

// When a key was last pressed anywhere in the window. An approval prompt takes focus
// from an empty message box only when the user has not been typing just now, so a
// prompt that appears mid-keystroke can never turn their next letter into a verdict.
let lastKeyAt = 0
let tracking = false
export function trackKeyActivity(): void {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  window.addEventListener('keydown', () => (lastKeyAt = Date.now()), true)
}
export const RECENT_TYPING_MS = 1500
export function typedRecently(now = Date.now()): boolean {
  return now - lastKeyAt < RECENT_TYPING_MS
}
/** Test seams. */
export function noteKeyActivity(at = Date.now()): void {
  lastKeyAt = at
}
export function resetKeyActivity(): void {
  lastKeyAt = 0
}

/**
 * Whether a newly shown approval prompt may take keyboard focus: from nowhere in
 * particular (the page body), or from an empty message box the user is not typing
 * in. Never out of a dialog, another field, or a control the user is on.
 */
export function mayTakeFocus(active: Element | null, now = Date.now()): boolean {
  if (typedRecently(now)) return false
  if (!active || active === document.body || active === document.documentElement) return true
  if (active.closest('[role="dialog"]')) return false
  if (active.tagName === 'TEXTAREA' && active.classList.contains('composer__input')) {
    return (active as HTMLTextAreaElement).value.trim() === ''
  }
  return false
}
