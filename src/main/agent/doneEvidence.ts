/**
 * The evidence-of-done note: what Houston's own record of a turn says is still open
 * when the model stops after making edits.
 *
 * The receipt shows the user what ran; the model never sees it. A model that ends its
 * turn saying "all tests pass" with a red last run, open todo items, or a suite it
 * loosened gets one system note at its natural stop, built from the ledger (no extra
 * model call, no extra command), listing only the gaps that are real: todo items still
 * open, no passing check after the last file change, a todo marked done with nothing
 * behind it, a failed last test run, and test edits that can turn a red suite green
 * (see testTampering.ts).
 * It asks, it doesn't order: some gaps can't be closed (no test suite, a check only the
 * user can run), and the model is told to say so in its reply instead.
 *
 * Pure: the loop gathers the facts and decides when to send it (once per turn).
 */
import type { TestEdit } from '@shared/evidence'
import type { Todo } from '@shared/todos'
import { testEditsNote } from './testTampering'
import { todoGapFacts, type TodoGap } from './todoEvidence'

/** What the loop knows about the turn at its natural stop. */
export interface DoneEvidence {
  /** Files the turn changed (file tools and shell commands), as the ledger lists them. */
  filesChanged: string[]
  /** A check of the code (test, typecheck, build, lint, ...) passed after the last change. */
  passedAfterLastWrite: boolean
  /** A check of the code passed, but only before a later change. */
  passedBeforeLastWrite: boolean
  /** The turn's most recent test run, when one ran. `ok` undefined: the outcome is unknown. */
  lastTest?: { label: string; ok: boolean | undefined; failed?: number }
  /** The todo list, when the turn wrote one (a list from an earlier turn is not this turn's plan). */
  todos?: Todo[]
  /** Todo items marked completed this turn that claim a check nothing backs. */
  todoGaps: TodoGap[]
  /** Edits that loosen a test (see testTampering.ts). */
  testEdits: TestEdit[]
}

/** Files whose change no check of the code is expected to cover. */
const PROSE_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$|(^|[\\/])(LICENSE|NOTICE|AUTHORS|CHANGELOG)[^\\/]*$/i

function clip(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

/** The gaps worth raising, one line each, or none. */
export function doneEvidenceGaps(e: DoneEvidence): string[] {
  const gaps: string[] = []
  const open = (e.todos ?? []).filter((t) => t.status !== 'completed')
  if (open.length) {
    const shown = open
      .slice(0, 5)
      .map((t) => `"${clip(t.content)}"${t.status === 'in_progress' ? ' (in progress)' : ''}`)
    const more = open.length > shown.length ? `, and ${open.length - shown.length} more` : ''
    gaps.push(
      `${open.length} todo item${open.length === 1 ? ' is' : 's are'} still open: ${shown.join(', ')}${more}.`
    )
  }
  const lastTestFailed = e.lastTest?.ok === false
  if (lastTestFailed && e.lastTest) {
    const failed = e.lastTest.failed ? ` (${e.lastTest.failed} failed)` : ''
    gaps.push(`The last test run failed${failed}: ${clip(e.lastTest.label)}.`)
  }
  const codeChanged = e.filesChanged.some((f) => !PROSE_FILE.test(f))
  if (codeChanged && !e.passedAfterLastWrite && !lastTestFailed) {
    gaps.push(
      e.passedBeforeLastWrite
        ? 'The last passing check ran before a later file change, so nothing has checked the final code.'
        : 'No test, typecheck, build, or lint run passed after the files changed.'
    )
  }
  for (const g of e.todoGaps.slice(0, 5)) gaps.push(`${todoGapFacts(g)}.`)
  return gaps
}

/**
 * The note sent to the model, or null when there is no real gap. Test edits keep the
 * wording of the note they had on their own (testEditsNote), after the other gaps.
 */
export function doneEvidenceNote(e: DoneEvidence): string | null {
  const gaps = doneEvidenceGaps(e)
  const tests = e.testEdits.length ? testEditsNote(e.testEdits) : ''
  if (!gaps.length) return tests || null
  const note =
    "Before you finish: Houston's record of this turn shows gaps between the work and the evidence that it is done.\n" +
    gaps.map((g) => `- ${g}`).join('\n') +
    '\nClose the gaps that apply: finish or update the open items, run the checks on the final code, and fix what failed.' +
    " If one can't be closed (the project has no tests, a check only the user can run, an item left for later), say so plainly in your reply rather than reporting it done. This note is sent once per turn."
  return tests ? `${note}\n\n${tests}` : note
}
