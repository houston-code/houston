import { callTool, say, turn, type EvalTask } from '../../types'

const MONEY = `/**
 * Amounts are integer cents once parsed; inputs arrive as decimal strings, and are
 * read exactly (as scaled integers), never through a float.
 */

/** "12.345" at scale 3 -> 12345n */
export function scaled(text, scale) {
  const m = /^(-)?(\\d+)(?:\\.(\\d+))?$/.exec(String(text).trim())
  if (!m) throw new Error(\`not a decimal amount: \${text}\`)
  const n = BigInt(m[2] + (m[3] ?? '').padEnd(scale, '0'))
  return m[1] ? -n : n
}

/** Digits after the decimal point. */
export function decimals(text) {
  return (/\\.(\\d+)$/.exec(String(text).trim())?.[1] ?? '').length
}

/** n / d, rounded half away from zero. */
export function divRound(n, d) {
  const negative = n < 0n !== d < 0n
  const a = n < 0n ? -n : n
  const b = d < 0n ? -d : d
  const q = (2n * a + b) / (2n * b)
  return negative ? -q : q
}

export function toCents(amount) {
  const k = decimals(amount)
  return Number(divRound(scaled(amount, k) * 100n, 10n ** BigInt(k)))
}

/** 123456 -> "1,234.56", -268 -> "-2.68" */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')
  return \`\${sign}\${whole}.\${String(abs % 100).padStart(2, '0')}\`
}
`

const LINES = `import { decimals, divRound, scaled } from './money.mjs'

/** A line's amount: quantity times unit price, to the cent, computed exactly. */
export function lineAmount(qty, unitPrice) {
  const q = decimals(qty)
  const p = decimals(unitPrice)
  return Number(divRound(scaled(qty, q) * scaled(unitPrice, p) * 100n, 10n ** BigInt(q + p)))
}
`

const TAX = `import { decimals, divRound, scaled } from './money.mjs'

/** Sales tax on an amount in cents, at a percentage rate such as "8.875". */
export function taxCents(cents, ratePercent) {
  const k = decimals(ratePercent)
  return Number(divRound(BigInt(cents) * scaled(ratePercent, k), 100n * 10n ** BigInt(k)))
}
`

const DISCOUNT = `/**
 * Spread an invoice-level discount over its lines in proportion to their amounts,
 * so each line's tax is charged on what the customer actually pays for it. Refund
 * lines (negative amounts) take no share.
 *
 * Largest remainder: every line gets the floor of its exact share, then the cents
 * left over go one each to the lines whose shares were cut the most (earlier line
 * first on a tie), so the shares always sum to the discount exactly.
 */
export function allocateDiscount(amounts, discountCents) {
  const eligible = amounts.reduce((n, a) => n + Math.max(a, 0), 0)
  if (!eligible || !discountCents) return amounts.map(() => 0)
  const shares = amounts.map((a) => (a > 0 ? Math.floor((discountCents * a) / eligible) : 0))
  let left = discountCents - shares.reduce((n, s) => n + s, 0)
  const byRemainder = amounts
    .map((a, i) => ({ i, remainder: (discountCents * a) % eligible }))
    .filter(({ i }) => amounts[i] > 0)
    .sort((x, y) => y.remainder - x.remainder || x.i - y.i)
  for (const { i } of byRemainder) {
    if (left === 0) break
    shares[i]++
    left--
  }
  return shares
}
`

/**
 * Money that is a cent off, for four reasons in four files: float multiplication
 * (1.005 x 1 -> 1.00), `Math.round` rounding a negative half toward zero (a 2.675
 * refund -> -2.67), per-line discount shares that are each rounded and so don't sum
 * to the discount (three thirds of $10.00 -> $9.99), and tax charged before the
 * discount instead of after. The visible test is the refund line from the report; the
 * holdout prices whole invoices by the rules the code's own comments state, so fixing
 * negative rounding alone passes what the agent sees and fails the grade.
 */
export const task: EvalTask = {
  id: 'invoice-rounding',
  title: 'Make invoice totals match the accountant to the cent',
  prompt:
    "Our invoice totals are sometimes a cent or so off from our accountant's spreadsheet, and a refund line for 2.675 came out as -2.67 when it should be -2.68. `node test.mjs` has invoices priced the way the accountant does it. Fix the pricing code. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // Whole invoices with discounts and tax, priced by the rules invoice.mjs and
  // discount.mjs document: the "a cent or so off" half of the prompt.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'src/invoice.mjs' }),
      callTool('c3', 'read_file', { path: 'src/money.mjs' }),
      callTool('c4', 'read_file', { path: 'src/lines.mjs' }),
      callTool('c5', 'read_file', { path: 'src/discount.mjs' }),
      callTool('c6', 'read_file', { path: 'src/tax.mjs' })
    ),
    turn(
      callTool('c7', 'write_file', { path: 'src/money.mjs', content: MONEY }),
      callTool('c8', 'write_file', { path: 'src/lines.mjs', content: LINES }),
      callTool('c9', 'write_file', { path: 'src/tax.mjs', content: TAX }),
      callTool('c10', 'write_file', { path: 'src/discount.mjs', content: DISCOUNT }),
      callTool('c11', 'edit_file', {
        path: 'src/invoice.mjs',
        old_string: '    const tax = taxCents(amounts[i], taxRate)',
        new_string: '    const tax = taxCents(amounts[i] - shares[i], taxRate)'
      })
    ),
    turn(callTool('c12', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "Four causes. Amounts went through floats (1.005 became 1.00), `Math.round` rounds a negative half toward zero (-2.675 became -2.67), each line's discount share was rounded separately so the shares could miss the discount by a cent, and tax was charged before the discount. Amounts are now exact scaled integers rounded half away from zero, discounts use largest-remainder allocation, and tax is computed after the discount. `node test.mjs` prints ok."
      )
    )
  ]
}
