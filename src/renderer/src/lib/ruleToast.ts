/**
 * What "Always allow" / "Always deny" on an approval prompt saved, so the app can name
 * the exact rule and offer to take it back. Shared with the terminal, which names the
 * rule the same way (see `src/shared/savedRules.ts`).
 */
export {
  describeRule,
  RULE_POLL_DELAYS,
  ruleActionOf,
  savedRulesSince,
  savedRulesText,
  waitForSavedRules,
  withoutRules
} from '@shared/savedRules'
