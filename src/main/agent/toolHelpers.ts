/**
 * Small helpers the built-in tool definitions share. A leaf module (type-only imports),
 * so tool modules that tools.ts itself imports, such as lsp/tools.ts, can use them
 * without an import cycle.
 */
import type { JSONSchema } from '@shared/agent'
import type { ToolContext } from './tools'

/** A string argument, or '' when absent or not a string. */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

/** The allowed roots for a tool call (workspace plus any added directories). */
export function rootsOf(ctx: ToolContext): string[] {
  return ctx.roots && ctx.roots.length ? ctx.roots : [ctx.workspace]
}

/** A closed object schema: these properties, these required, nothing else. */
export const objectSchema = (properties: JSONSchema, required: string[]): JSONSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
