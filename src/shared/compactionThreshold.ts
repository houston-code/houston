import { DEFAULT_COMPACTION_THRESHOLD } from './defaults'
import { formatTokens } from './usage'

/**
 * When automatic context compaction kicks in. Pure and shared, so the loop that acts
 * on it and the `/context` view in both clients that report it agree.
 */

/**
 * Fraction of the model's context window at which proactive compaction kicks in.
 * The remaining fifth is headroom for the next turn's growth (tool results, the
 * model's output, attachments) and for the slack in the ~4-chars-per-token
 * estimate, so a turn that lands right at the threshold still fits comfortably.
 * It is also the safety margin no user setting can raise the threshold past.
 */
export const COMPACTION_WINDOW_FRACTION = 0.8

/**
 * Share of a model's long-context price tier kept free below its boundary. Past the
 * boundary every token of a request bills at the higher rate (see `turnCostUsd`), so
 * compaction aims under it with room for the next turn's growth and the slack in the
 * ~4-chars-per-token estimate.
 */
export const PRICE_TIER_HEADROOM_FRACTION = 0.1

/**
 * The user's own compaction trigger, from settings: an absolute token count
 * (`compactionThreshold`) and/or a share of the context window
 * (`compactionThresholdPercent`, 1 to 100). Either set to 0 turns compaction off.
 */
export interface CompactionLimit {
  tokens?: number
  percent?: number
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function knownWindow(contextWindow: number | null): contextWindow is number {
  return typeof contextWindow === 'number' && contextWindow > 0
}

/** The price-tier ceiling in tokens, or null when the model has no such tier. */
function tierCeiling(priceTierAbove: number | null | undefined): number | null {
  return finite(priceTierAbove) && priceTierAbove > 0
    ? Math.floor(priceTierAbove * (1 - PRICE_TIER_HEADROOM_FRACTION))
    : null
}

/**
 * The automatic threshold, before any user setting: a fixed share of the selected
 * model's context window. A fixed count is mis-sized in both directions for a
 * bring-your-own-model product (far too eager on a 1M-token model, far too late on a
 * 16k local one), so the fixed default covers only a window that is unknown (a
 * custom/local model with no capability metadata).
 *
 * `priceTierAbove` is the prompt size past which the model bills at its long-context
 * rate (`ModelPricing.longContext.above`), when it has one. The threshold then stays
 * under that boundary less {@link PRICE_TIER_HEADROOM_FRACTION}: a window left to grow
 * to 80% of a 1M window would bill most of a long session at several times the base
 * rate.
 */
export function automaticCompactionThreshold(
  contextWindow: number | null,
  priceTierAbove?: number | null
): number {
  const byWindow = knownWindow(contextWindow)
    ? Math.floor(contextWindow * COMPACTION_WINDOW_FRACTION)
    : DEFAULT_COMPACTION_THRESHOLD
  const tier = tierCeiling(priceTierAbove)
  return tier === null ? byWindow : Math.min(byWindow, tier)
}

/** Read the settings fields into a limit (a bare number is a token count). */
function normalizeLimit(limit: number | CompactionLimit | undefined): CompactionLimit {
  if (limit === undefined) return {}
  return typeof limit === 'number' ? { tokens: limit } : limit
}

/** Whether a user setting turns compaction off (0, or a junk negative value). */
function disables(v: number | undefined): boolean {
  return finite(v) && v <= 0
}

/**
 * The lowest of the user's own triggers in tokens, or null when none applies. A
 * percentage needs a known window, so it is skipped when the window is unknown.
 */
function userCap(limit: CompactionLimit, contextWindow: number | null): number | null {
  const caps: number[] = []
  if (finite(limit.tokens)) caps.push(Math.floor(limit.tokens))
  if (finite(limit.percent) && knownWindow(contextWindow)) {
    caps.push(Math.max(1, Math.floor((contextWindow * Math.min(100, limit.percent)) / 100)))
  }
  return caps.length ? Math.min(...caps) : null
}

/**
 * The effective compaction threshold in tokens (0 means compaction is off). The
 * automatic threshold (window share and price tier) applies unless the user set
 * their own trigger, which is one more minimum: it can only lower the threshold, so
 * a token count or a share of the window above the automatic threshold is capped
 * there and a setting never pushes the window past its safety margin. With the
 * window unknown there is no margin to hold to, so a token count applies as written
 * (still under a price tier) and a percentage, which needs a window, is ignored.
 * 0 in either field disables compaction; a non-finite value is ignored.
 */
export function resolveCompactionThreshold(
  limit: number | CompactionLimit | undefined,
  contextWindow: number | null,
  priceTierAbove?: number | null
): number {
  const norm = normalizeLimit(limit)
  if (disables(norm.tokens) || disables(norm.percent)) return 0
  const auto = automaticCompactionThreshold(contextWindow, priceTierAbove)
  const user = userCap(norm, contextWindow)
  if (user === null) return auto
  if (knownWindow(contextWindow)) return Math.min(auto, user)
  const tier = tierCeiling(priceTierAbove)
  return tier === null ? user : Math.min(user, tier)
}

/** Whether the user set a trigger of their own that applies (a token count or a share of a known window). */
export function hasUserCompactionLimit(
  limit: number | CompactionLimit | undefined,
  contextWindow: number | null
): boolean {
  const norm = normalizeLimit(limit)
  return disables(norm.tokens) || disables(norm.percent) || userCap(norm, contextWindow) !== null
}

/** The settings fields as a limit, for {@link resolveCompactionThreshold}. */
export function compactionLimitFrom(settings: {
  compactionThreshold?: number
  compactionThresholdPercent?: number
}): CompactionLimit {
  return { tokens: settings.compactionThreshold, percent: settings.compactionThresholdPercent }
}

/**
 * One line for `/context`: where automatic compaction will kick in, and whether
 * that comes from the user's setting or the automatic sizing.
 */
export function compactionThresholdNote(
  limit: CompactionLimit,
  contextWindow: number | null,
  priceTierAbove?: number | null
): string {
  const threshold = resolveCompactionThreshold(limit, contextWindow, priceTierAbove)
  if (threshold <= 0) return 'Automatic compaction is off (Settings, Agent Behavior, Context window).'
  const at = `Compacts automatically at about ${formatTokens(threshold)} tokens`
  const margin = `${Math.round(COMPACTION_WINDOW_FRACTION * 100)}%`
  const user = userCap(limit, contextWindow)
  const tier = tierCeiling(priceTierAbove)
  const underTier = tier !== null && threshold === tier
  if (user === null) {
    if (underTier) return `${at} (automatic: under the long-context price tier).`
    return knownWindow(contextWindow)
      ? `${at} (automatic: ${margin} of the window).`
      : `${at} (automatic: the model's window is unknown).`
  }
  const set = [
    finite(limit.percent) && knownWindow(contextWindow) ? `${limit.percent}% of the window` : '',
    finite(limit.tokens) ? `${formatTokens(limit.tokens)} tokens` : ''
  ]
    .filter(Boolean)
    .join(' or ')
  if (user <= threshold) return `${at} (your setting: ${set}).`
  return underTier
    ? `${at} (your setting, ${set}, is capped under the long-context price tier).`
    : `${at} (your setting, ${set}, is capped at the ${margin} safety margin).`
}

/** How the settings page presents the trigger: which of the two fields is in use. */
export type CompactionMode = 'auto' | 'percent' | 'tokens' | 'off'

interface CompactionFields {
  compactionThreshold?: number
  compactionThresholdPercent?: number
}

/** Starting values when the user picks a mode that needs a number. */
export const DEFAULT_COMPACTION_PERCENT = 60
export const DEFAULT_COMPACTION_TOKENS = 100_000

/** The mode a settings object is in (0 in either field is "off"). */
export function compactionMode(s: CompactionFields): CompactionMode {
  if (disables(s.compactionThreshold) || disables(s.compactionThresholdPercent)) return 'off'
  if (finite(s.compactionThresholdPercent)) return 'percent'
  if (finite(s.compactionThreshold)) return 'tokens'
  return 'auto'
}

/**
 * `s` switched to `mode`, keeping its current number when it already has one. Only
 * the field the mode uses is stored, so automatic leaves neither behind.
 */
export function withCompactionMode<T extends CompactionFields>(s: T, mode: CompactionMode): T {
  const { compactionThreshold, compactionThresholdPercent, ...rest } = s
  const keep = (v: number | undefined, fallback: number): number => (finite(v) && v > 0 ? v : fallback)
  switch (mode) {
    case 'auto':
      return rest as T
    case 'off':
      return { ...rest, compactionThreshold: 0 } as T
    case 'percent':
      return { ...rest, compactionThresholdPercent: keep(compactionThresholdPercent, DEFAULT_COMPACTION_PERCENT) } as T
    case 'tokens':
      return { ...rest, compactionThreshold: keep(compactionThreshold, DEFAULT_COMPACTION_TOKENS) } as T
  }
}
