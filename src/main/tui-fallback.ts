import type { AppSettings, SelectedModel } from '@shared/types'
import { addFallback, fallbackRows, moveFallback, removeFallback } from '@shared/fallbackModels'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * `/model fallback [list|add|remove|up|down]` in the terminal: the models Houston
 * tries, in order, when the chat's model can't serve a turn (the desktop edits the
 * same list on its Models page).
 */

export type FallbackOp =
  | { op: 'list' }
  | { op: 'add'; model: string }
  | { op: 'remove' | 'up' | 'down'; index: number }
  | { op: 'usage' }

export const FALLBACK_USAGE =
  'usage: /model fallback [list] · add <model> · remove <n> · up <n> · down <n>'

/** Read the words after `/model fallback`. */
export function parseFallbackArgs(arg: string): FallbackOp {
  const [verb, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  if (!verb || verb.toLowerCase() === 'list') return rest.length ? { op: 'usage' } : { op: 'list' }
  const v = verb.toLowerCase()
  if (v === 'add') return rest.length === 1 ? { op: 'add', model: rest[0] } : { op: 'usage' }
  const op = v === 'rm' || v === 'delete' ? 'remove' : v
  if (op === 'remove' || op === 'up' || op === 'down') {
    const n = Number(rest[0])
    return rest.length === 1 && Number.isInteger(n) && n >= 1 ? { op, index: n - 1 } : { op: 'usage' }
  }
  return { op: 'usage' }
}

/** The chain, numbered, with each entry a run would skip marked. */
export function renderFallbacks(settings: AppSettings, paint: Painter): string {
  const rows = fallbackRows(settings)
  if (!rows.length) {
    return paint(
      '· no fallback models: a turn the model cannot serve just ends. /model fallback add <model> names one',
      'dim'
    )
  }
  const lines = [paint('Fallback models (tried in order when the chat\'s model cannot serve a turn):', 'bold')]
  rows.forEach((r, i) => {
    const label = stripControlChars(r.label)
    lines.push(`  ${i + 1}. ${label}${r.skipped ? paint(`  (skipped: ${r.skipped})`, 'yellow') : ''}`)
  })
  lines.push(paint('  /model fallback add <model> · remove <n> · up <n> · down <n>', 'dim'))
  return lines.join('\n')
}

/**
 * The new list for a change, or why it can't be made. `resolve` turns a typed
 * model (`id`, `provider/id`, or a display name) into a model, as `/model` does.
 */
export function fallbackChange(
  op: Exclude<FallbackOp, { op: 'list' | 'usage' }>,
  settings: AppSettings,
  resolve: (typed: string) => SelectedModel | null
): { list: SelectedModel[]; message: string } | { error: string } {
  const list = settings.fallbackModels ?? []
  if (op.op === 'add') {
    const m = resolve(op.model)
    if (!m) return { error: `· no model "${stripControlChars(op.model)}"; /model lists them` }
    const next = addFallback(list, m)
    if ('error' in next) return { error: `· ${next.error}` }
    return { list: next, message: `· fallback ${next.length}: ${m.providerId}/${m.model}` }
  }
  if (op.index >= list.length) {
    return { error: `· no fallback ${op.index + 1}; /model fallback lists them` }
  }
  const gone = list[op.index]
  if (op.op === 'remove') {
    return { list: removeFallback(list, op.index), message: `· removed fallback ${gone.providerId}/${gone.model}` }
  }
  const next = moveFallback(list, op.index, op.op === 'up' ? -1 : 1)
  const at = next.findIndex((f) => f === gone)
  return { list: next, message: `· ${gone.providerId}/${gone.model} is now fallback ${at + 1}` }
}
