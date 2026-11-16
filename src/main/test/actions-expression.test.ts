import { describe, expect, it } from 'vitest'
import { evaluate, evaluateIf, type ExpressionContext } from './actions-expression'

/** The workflow tests trust this evaluator's answers, so its semantics are pinned here. */
const ctx = (contexts: ExpressionContext['contexts'], cancelled = false): ExpressionContext => ({ contexts, cancelled })
const none = ctx({})

describe('the Actions expression evaluator', () => {
  it('returns an operand from && and ||, not a boolean', () => {
    expect(evaluate("${{ 'a' && 'b' }}", none)).toBe('b')
    expect(evaluate("${{ '' && 'b' }}", none)).toBe('')
    expect(evaluate("${{ false || 'b' }}", none)).toBe('b')
    expect(evaluate("${{ 'a' || 'b' }}", none)).toBe('a')
    // The usual `cond && value || fallback` chain, ending in a fallback.
    expect(evaluate("${{ false && 'x' || '' }}", none)).toBe('')
    expect(evaluate("${{ false && 'x' }}", none)).toBe(false)
  })

  it('evaluates && before ||, and parentheses first', () => {
    expect(evaluate("${{ true || false && false }}", none)).toBe(true)
    expect(evaluate("${{ (true || false) && false }}", none)).toBe(false)
    expect(evaluate("${{ !false && !'' }}", none)).toBe(true)
    expect(evaluate("${{ !'x' }}", none)).toBe(false)
  })

  it('compares strings without regard to case, and different types as numbers', () => {
    expect(evaluate("${{ 'Success' == 'success' }}", none)).toBe(true)
    expect(evaluate("${{ 'a' != 'b' }}", none)).toBe(true)
    expect(evaluate("${{ '1' == 1 }}", none)).toBe(true)
    expect(evaluate("${{ '' == 0 }}", none)).toBe(true)
    expect(evaluate("${{ null == false }}", none)).toBe(true)
    expect(evaluate("${{ 'x' == 0 }}", none)).toBe(false)
  })

  it('reads properties without regard to case, and a missing one as null', () => {
    const c = ctx({ needs: { resolve: { result: 'success', outputs: { key: 'k' } } } })
    expect(evaluate('${{ needs.resolve.outputs.key }}', c)).toBe('k')
    expect(evaluate('${{ NEEDS.Resolve.RESULT }}', c)).toBe('success')
    expect(evaluate('${{ needs.evals.result }}', c)).toBe(null)
    expect(evaluate('${{ needs.evals.outputs.key }}', c)).toBe(null)
    expect(evaluate("${{ needs.evals.result == '' }}", c)).toBe(true)
  })

  it('filters with * and searches the result with contains', () => {
    const c = ctx({ needs: { a: { result: 'success' }, b: { result: 'Cancelled' } } })
    expect(evaluate('${{ needs.*.result }}', c)).toEqual(['success', 'Cancelled'])
    expect(evaluate("${{ contains(needs.*.result, 'cancelled') }}", c)).toBe(true)
    expect(evaluate("${{ contains(needs.*.result, 'failure') }}", c)).toBe(false)
    expect(evaluate("${{ contains('Hello', 'ell') }}", none)).toBe(true)
  })

  it('formats with numbered arguments and escaped braces', () => {
    expect(evaluate("${{ format('{0}/{1}', 'a', 'b') }}", none)).toBe('a/b')
    expect(evaluate("${{ format('{{{0}}}', 'x') }}", none)).toBe('{x}')
    expect(evaluate("${{ format('{0}', null) }}", none)).toBe('')
    expect(() => evaluate("${{ format('{1}', 'a') }}", none)).toThrow(/no argument/)
  })

  it('keeps a whole expression typed, interpolates one inside text, and leaves plain text as is', () => {
    expect(evaluate("${{ 'a' == 'a' }}", none)).toBe(true)
    expect(evaluate("x-${{ 'a' == 'a' }}-${{ format('{0}', 'y') }}", none)).toBe('x-true-y')
    expect(evaluate('Task evals (live)', none)).toBe('Task evals (live)')
    expect(evaluate("${{ 'it''s' }}", none)).toBe("it's")
    // A `}}` or a quote inside a string literal doesn't end the expression.
    expect(evaluate("${{ format('{0}}}', 'a') }} and ${{ 'it''s }}' }}", none)).toBe('a} and it\'s }}')
    expect(() => evaluate("${{ 'a' ", none)).toThrow(/Unterminated/)
  })

  it("defaults an `if:` to success(), and ANDs one with no status function with it", () => {
    const failed = ctx({ needs: { a: { result: 'failure' } } })
    const passed = ctx({ needs: { a: { result: 'success' } } })
    expect(evaluateIf(undefined, passed)).toBe(true)
    expect(evaluateIf(undefined, failed)).toBe(false)
    expect(evaluateIf('${{ true }}', failed)).toBe(false)
    expect(evaluateIf('${{ always() && true }}', failed)).toBe(true)
    expect(evaluateIf('${{ failure() }}', failed)).toBe(true)
    expect(evaluateIf("needs.a.result == 'failure'", failed)).toBe(false)
    expect(evaluateIf("always() && needs.a.result == 'failure'", failed)).toBe(true)
  })

  it('reads cancelled() from the run, and fails success() in a cancelled run', () => {
    const passed = (cancelled: boolean) => ctx({ needs: { a: { result: 'success' } } }, cancelled)
    expect(evaluateIf('${{ !cancelled() }}', passed(true))).toBe(false)
    expect(evaluateIf('${{ !cancelled() }}', passed(false))).toBe(true)
    expect(evaluateIf(undefined, passed(true))).toBe(false)
  })

  it('throws on syntax and functions it does not model, rather than guessing', () => {
    expect(() => evaluate("${{ startsWith('a', 'a') }}", none)).toThrow(/Unsupported function/)
    expect(() => evaluate('${{ 1 < 2 }}', none)).toThrow(/Unsupported syntax/)
    expect(() => evaluate("${{ needs['a'] }}", none)).toThrow(/Unsupported syntax/)
    // The open literal runs past the `}}`, so the expression never closes.
    expect(() => evaluate("${{ 'open }}", none)).toThrow(/Unterminated \$\{\{/)
    expect(() => evaluateIf("'open", none)).toThrow(/Unterminated string/)
    expect(() => evaluateIf("x-${{ true }}", none)).toThrow(/not modelled/)
    expect(() => evaluate("${{ ('a' }}", none)).toThrow(/Expected '\)'/)
    expect(() => evaluate("${{ 'a' 'b' }}", none)).toThrow(/trailing tokens/)
  })
})
