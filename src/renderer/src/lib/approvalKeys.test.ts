import { afterEach, describe, expect, it } from 'vitest'
import {
  approvalKeyDecision,
  isApprovalKeyEvent,
  isTypingTarget,
  mayTakeFocus,
  noteKeyActivity,
  resetKeyActivity
} from './approvalKeys'

describe('approvalKeys', () => {
  afterEach(() => {
    resetKeyActivity()
    document.body.innerHTML = ''
  })

  it('maps Y / A / N per prompt variant, case-insensitively', () => {
    expect(approvalKeyDecision('y', 'standard')).toBe('allow')
    expect(approvalKeyDecision('A', 'standard')).toBe('always')
    expect(approvalKeyDecision('n', 'standard')).toBe('deny')
    expect(approvalKeyDecision('d', 'standard')).toBeNull()
    expect(approvalKeyDecision('y', 'chat-grant')).toBe('always')
    expect(approvalKeyDecision('a', 'chat-grant')).toBeNull()
    expect(approvalKeyDecision('N', 'chat-grant')).toBe('deny')
  })

  it('never offers a key for the rule-saving verdicts', () => {
    for (const k of 'abcdefghijklmnopqrstuvwxyz!') {
      const d = approvalKeyDecision(k, 'standard')
      expect(d === 'rule-allow' || d === 'rule-deny').toBe(false)
    }
  })

  it('treats text fields as typing and buttons as not', () => {
    const text = document.createElement('input')
    const check = document.createElement('input')
    check.type = 'checkbox'
    const area = document.createElement('textarea')
    const btn = document.createElement('button')
    expect(isTypingTarget(text)).toBe(true)
    expect(isTypingTarget(area)).toBe(true)
    expect(isTypingTarget(check)).toBe(false)
    expect(isTypingTarget(btn)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('reads only plain, unrepeated, single-character keys', () => {
    const base = { key: 'y', metaKey: false, ctrlKey: false, altKey: false, repeat: false, defaultPrevented: false }
    expect(isApprovalKeyEvent(base)).toBe(true)
    expect(isApprovalKeyEvent({ ...base, ctrlKey: true })).toBe(false)
    expect(isApprovalKeyEvent({ ...base, repeat: true })).toBe(false)
    expect(isApprovalKeyEvent({ ...base, defaultPrevented: true })).toBe(false)
    expect(isApprovalKeyEvent({ ...base, key: 'Enter' })).toBe(false)
  })

  it('takes focus only from the body or an empty, idle message box', () => {
    const box = document.createElement('textarea')
    box.className = 'composer__input'
    document.body.appendChild(box)
    expect(mayTakeFocus(document.body)).toBe(true)
    expect(mayTakeFocus(box)).toBe(true)
    box.value = 'hello'
    expect(mayTakeFocus(box)).toBe(false)
    box.value = ''
    noteKeyActivity(1000)
    expect(mayTakeFocus(box, 1200)).toBe(false)
    expect(mayTakeFocus(box, 5000)).toBe(true)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inner = document.createElement('button')
    dialog.appendChild(inner)
    document.body.appendChild(dialog)
    expect(mayTakeFocus(inner, 5000)).toBe(false)
    expect(mayTakeFocus(document.createElement('input'), 5000)).toBe(false)
  })
})
