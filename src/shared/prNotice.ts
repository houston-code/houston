/**
 * Detect a pull-request lifecycle signal (opened / merged) in the output of a
 * `gh_pr_*` tool call, so the transcript can highlight it as a notice and the
 * main process can fire an OS ping. Pure and string-only — it reads the same
 * tool output the agent already produced behind its network approval, so it adds
 * no new egress and no background polling (merges are caught opportunistically
 * when the agent runs `gh_pr_view`, never by polling GitHub).
 *
 * Shared by the renderer (in-app notice, live + on reload) and the main process
 * (desktop notification) so both surfaces agree on what counts as an event.
 */

export type PrNoticeEvent = 'created' | 'merged'

export interface PrNotice {
  event: PrNoticeEvent
  /** PR number, when it could be parsed from the output. */
  number?: number
  /** PR URL, when present in the output. */
  url?: string
}

/** First PR URL in the text (`…/pull/<n>`), capturing the URL and its number. */
const PR_URL = /(https?:\/\/[^\s)]+\/pull\/(\d+))/

/**
 * The created/merged signal in a `gh_pr_*` tool result, or null if there's none.
 *
 * - `gh_pr_create` succeeds by printing the new PR's URL → a `created` notice.
 * - `gh_pr_view` of a single PR whose state is MERGED → a `merged` notice
 *   ({@link formatPrView} renders the state as a `[merged]` tag on the first line).
 *
 * `gh_pr_list` is deliberately ignored: a "merged" listing is a bulk query, not a
 * just-happened event, and would spam one banner per row. Failed gh calls return
 * a `gh failed …` string with no PR URL / `[merged]` tag, so they match nothing.
 */
export function prNoticeFromToolResult(
  name: string,
  ok: boolean,
  output: string
): PrNotice | null {
  if (!ok || !output) return null

  if (name === 'gh_pr_create') {
    const m = output.match(PR_URL)
    if (!m) return null
    return { event: 'created', number: Number(m[2]), url: m[1] }
  }

  if (name === 'gh_pr_view') {
    const firstLine = output.split('\n', 1)[0] ?? ''
    const num = firstLine.match(/^#(\d+)\b/)
    const tag = firstLine.match(/\[(\w+)\]\s*$/)
    if (!num || !tag || tag[1].toLowerCase() !== 'merged') return null
    const url = output.match(PR_URL)
    return { event: 'merged', number: Number(num[1]), url: url?.[1] }
  }

  return null
}

/** Human-facing text for a PR notice, used for the in-app transcript banner. */
export function prNoticeText(n: PrNotice): string {
  const num = n.number ? ` #${n.number}` : ''
  const url = n.url ? ` · ${n.url}` : ''
  return n.event === 'created'
    ? `🔀 Opened pull request${num}${url}`
    : `✅ Pull request${num} merged${url}`
}
