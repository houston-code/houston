import { describe, it, expect } from 'vitest'
import { nextApprovalPolicy } from './policyCycle'

describe('nextApprovalPolicy', () => {
  it('cycles forward through the escalating-trust order, wrapping', () => {
    expect(nextApprovalPolicy('plan')).toBe('ask')
    expect(nextApprovalPolicy('ask')).toBe('auto-edit')
    expect(nextApprovalPolicy('auto-edit')).toBe('full-auto')
    expect(nextApprovalPolicy('full-auto')).toBe('plan') // wrap
  })

  it('cycles backward when given dir -1', () => {
    expect(nextApprovalPolicy('plan', -1)).toBe('full-auto') // wrap
    expect(nextApprovalPolicy('full-auto', -1)).toBe('auto-edit')
  })
})
