/**
 * Exhaustiveness helper. Put `assertNever(x)` in the `default:` of a switch over a
 * discriminated union (or any spot that should be unreachable): TypeScript narrows
 * `x` to `never` only when every case is handled, so adding a new variant to the
 * union turns the unhandled client into a COMPILE error rather than a silent
 * no-op. This is the guard that keeps the multiple `AgentEvent` consumers (TUI,
 * GUI reducer, headless) from drifting apart as new event types are added.
 *
 * At runtime it throws — it should be unreachable if the code type-checks, so a
 * throw means an out-of-union value was fabricated somewhere and failing loudly
 * beats limping on with corrupt state.
 */
export function assertNever(value: never, context?: string): never {
  const label = context ? `${context}: ` : ''
  throw new Error(`${label}unexpected value ${JSON.stringify(value)}`)
}
