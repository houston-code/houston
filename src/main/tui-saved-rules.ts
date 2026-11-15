import type { PermissionRule } from '@shared/types'
import { describeRule, ruleIdentity, savedRulesText } from '@shared/savedRules'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * The lines printed after "Always allow" / "Always deny" at a terminal approval: the
 * rule(s) the answer actually saved (a shell allow is saved as generalized prefixes, a
 * patch as one rule per file), each with the number `/permissions remove <n>` takes,
 * so the person can see what now applies and how to take it back.
 */
export function renderSavedRules(
  saved: readonly PermissionRule[],
  all: readonly PermissionRule[],
  action: 'allow' | 'deny',
  paint: Painter
): string {
  const lines = [paint(`· ${savedRulesText(saved, action)}`, 'dim')]
  if (!saved.length) return lines.join('\n')
  const index = new Map(all.map((r, i) => [ruleIdentity(r), i + 1]))
  const numbers: number[] = []
  for (const r of saved) {
    const n = index.get(ruleIdentity(r))
    if (n !== undefined) numbers.push(n)
    // A rule's text can carry what the agent wrote (a command), so no control characters.
    lines.push(paint(`    ${n !== undefined ? `${n}. ` : ''}${stripControlChars(describeRule(r))}`, 'dim'))
  }
  if (numbers.length) {
    // Removing one renumbers the rules after it, so several are listed highest first.
    const how = [...numbers]
      .sort((a, b) => b - a)
      .map((n) => `/permissions remove ${n}`)
      .join(', then ')
    lines.push(paint(`  To take it back: ${how}.`, 'dim'))
  }
  return lines.join('\n')
}
