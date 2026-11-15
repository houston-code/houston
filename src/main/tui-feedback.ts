import type { Painter, TuiDeps } from './tui'
import type { PickerOption } from './tui-picker'
import { stripControlCharsKeepLines } from './tui-wrap'

/**
 * `/feedback` (also `/bug`): the terminal's Help > Report an Issue. It builds the
 * same report the desktop app does (@shared/issueReport: version, platform and a
 * summary of the diagnostics, with no logs, file paths or keys), shows exactly that
 * text, and only then, if the user chooses, opens the new-issue page in the browser
 * or prints its link. Nothing is sent from here: the user submits it on GitHub.
 */

export interface IssueReportHost {
  /** The text the new issue starts with (already through the secret redacter). Throws when diagnostics fail. */
  body: () => string
  /** The new-issue page, prefilled with `body` (blank when null). */
  url: (body: string | null) => string
  /** Hand a URL to the system browser; false when it couldn't. */
  open: (url: string) => boolean
}

export const FEEDBACK_INTRO = [
  'Report an issue',
  'This opens a new issue on GitHub in your browser, starting with the text below. It includes',
  'your Houston version, platform, and a summary of the diagnostics. It includes no logs, file',
  'paths, or keys. Describe what happened there before you submit; nothing is sent until you do.'
]

/** Where a chat transcript fits in, since the report never carries one. */
export const FEEDBACK_CHAT_NOTE =
  'To share this chat too, /export it, read the file over, and attach it to the issue yourself.'

export type FeedbackChoice = 'open' | 'print' | 'cancel'

/** A typed answer to the feedback question (the prompt fallback with no picker). */
export function parseFeedbackChoice(answer: string | null): FeedbackChoice {
  const a = (answer ?? '').trim().toLowerCase()
  if (a === 'o' || a === 'open' || a === '1') return 'open'
  if (a === 'p' || a === 'print' || a === 'link' || a === '2') return 'print'
  return 'cancel'
}

export async function runFeedbackCommand(deps: TuiDeps, paint: Painter): Promise<void> {
  const host = deps.issueReport
  if (!host) {
    deps.io.out(paint('· reporting an issue is unavailable here\n', 'dim'))
    return
  }
  let body: string | null
  try {
    body = host.body()
  } catch {
    body = null
  }
  const [title, ...intro] = FEEDBACK_INTRO
  deps.io.out(`${paint(title, 'bold')}\n${intro.join('\n')}\n\n`)
  if (body === null) {
    deps.io.out(paint("· couldn't gather the diagnostics. You can still open a blank issue.\n", 'yellow'))
  } else {
    // The report is built from Houston's own checks, but a check's name could carry a
    // server's text: never let it reach the terminal as escape sequences.
    const shown = stripControlCharsKeepLines(body).replace(/\n+$/, '')
    deps.io.out(`${shown.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n')}\n\n`)
  }
  deps.io.out(paint(`${FEEDBACK_CHAT_NOTE}\n`, 'dim'))

  const options: PickerOption[] = [
    { label: 'Open in browser', value: 'open', description: 'the new-issue page with this text filled in' },
    { label: 'Print the link', value: 'print', description: 'to open it yourself or on another computer' },
    { label: 'Cancel', value: 'cancel' }
  ]
  let choice: FeedbackChoice = 'cancel'
  if (deps.io.select) {
    const r = await deps.io.select({ title: 'Report it?', options })
    if (r.kind === 'commit') choice = parseFeedbackChoice(r.value)
    else if (r.kind === 'type') choice = parseFeedbackChoice(r.text ?? (await deps.io.readLine('[o]pen, [p]rint the link, or Enter to cancel: ', { discardPending: true })))
  } else {
    choice = parseFeedbackChoice(
      await deps.io.readLine('[o]pen in browser, [p]rint the link, or Enter to cancel: ', { discardPending: true })
    )
  }
  if (choice === 'cancel') {
    deps.io.out(paint('· nothing opened\n', 'dim'))
    return
  }
  const url = host.url(body)
  if (choice === 'open' && host.open(url)) {
    deps.io.out(paint('· opened the new-issue page in your browser (no browser? /feedback again and print the link)\n', 'dim'))
    return
  }
  if (choice === 'open') deps.io.out(paint("· couldn't open a browser here; the link:\n", 'yellow'))
  deps.io.out(`${url}\n`)
}
