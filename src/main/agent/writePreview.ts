import { promises as fs } from 'node:fs'
import { diffLines, type DiffLine, type FileDiffPreview } from '@shared/diff'
import { parsePatch } from './apply-patch'
import { resolveEdit } from './edit-match'
import { editNotebook, parseNotebook, renderNotebook, type NotebookEditMode } from './notebook'
import { resolveInRoots } from './tools'

/**
 * Compute what a write-kind tool call WOULD do to each file it touches, as a diff
 * against the file's current contents, before the call runs.
 *
 * This exists because the approval card cannot work it out for itself. The renderer
 * has no filesystem, so it cannot know what a file already holds — which is why a
 * `write_file` over an existing file used to render as if every line were new, when
 * in reality it might be replacing one word in a 400-line file. And `multi_edit` /
 * `apply_patch` had no diff at all: what they produce depends on the current text
 * and on the resilient edit matcher, both of which live here in the main process.
 * So the answer is computed here, where the file and the matcher are, and shipped
 * to the UI with the approval.
 *
 * It is computed BEFORE the write for two reasons: the user approving a change must
 * see the change they are approving, and once the write lands the "before" is gone,
 * so a diff recomputed afterwards could never be anything but wrong.
 *
 * Best-effort by construction: a preview is a UI nicety, never a gate. Anything that
 * can fail — an unreadable file, an edit whose old_string doesn't match, a malformed
 * patch — yields no preview rather than an error, and the tool itself still runs and
 * reports the real failure. See {@link previewWrite}.
 */

/**
 * Max diff lines carried per file. A preview crosses IPC and is held in the
 * renderer for the life of the conversation, so an unbounded overwrite of a large
 * file would ship a payload far past anything a person is going to read. The
 * remainder is marked `truncated` rather than silently dropped.
 */
export const MAX_PREVIEW_DIFF_LINES = 400

/** Current contents of a file, or null when it does not exist / cannot be read. */
async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/** Cut a diff to the line budget, flagging it when anything was dropped. */
function bounded(path: string, diff: DiffLine[], rest: Omit<FileDiffPreview, 'path' | 'diff'>): FileDiffPreview {
  return diff.length > MAX_PREVIEW_DIFF_LINES
    ? { path, diff: diff.slice(0, MAX_PREVIEW_DIFF_LINES), ...rest, truncated: true }
    : { path, diff, ...rest }
}

/** One file's before/after reduced to a preview entry. */
function previewOf(
  path: string,
  before: string | null,
  after: string | null
): FileDiffPreview {
  return bounded(path, diffLines(before ?? '', after ?? ''), {
    ...(before === null ? { created: true } : {}),
    ...(after === null ? { deleted: true } : {})
  })
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string) : ''
}

/**
 * Per-file diffs a write-kind call would produce, or null when no preview can be
 * built (an unknown tool, an edit that won't apply, an unreadable file).
 *
 * `null` and `[]` mean different things: null is "we could not work it out", while
 * an empty array is a call that touches no files. Both render as no diff, but only
 * null means the UI is missing something it wanted.
 */
export async function previewWrite(
  name: string,
  args: Record<string, unknown>,
  roots: string[]
): Promise<FileDiffPreview[] | null> {
  try {
    switch (name) {
      case 'write_file': {
        const path = str(args, 'path')
        if (!path || typeof args.content !== 'string') return null
        const before = await readOrNull(resolveInRoots(roots, path))
        // The whole point of this case: diff against what is actually there, so an
        // overwrite that changes one line reads as one line changed.
        return [previewOf(path, before, args.content)]
      }

      case 'edit_file': {
        const path = str(args, 'path')
        if (!path) return null
        const abs = resolveInRoots(roots, path)
        const before = await readOrNull(abs)
        if (before === null) return null
        const { content } = resolveEdit(before, str(args, 'old_string'), str(args, 'new_string'), args.replace_all === true)
        return [previewOf(path, before, content)]
      }

      case 'multi_edit': {
        const path = str(args, 'path')
        const edits = args.edits
        if (!path || !Array.isArray(edits) || edits.length === 0) return null
        const abs = resolveInRoots(roots, path)
        const before = await readOrNull(abs)
        if (before === null) return null
        // Apply in order, exactly as the tool does — each edit sees the previous
        // one's result — so the preview is the real combined outcome and not a
        // per-edit approximation.
        let after = before
        for (const raw of edits) {
          if (raw === null || typeof raw !== 'object') return null
          const e = raw as Record<string, unknown>
          after = resolveEdit(after, str(e, 'old_string'), str(e, 'new_string'), e.replace_all === true).content
        }
        return [previewOf(path, before, after)]
      }

      case 'notebook_edit': {
        const path = str(args, 'path')
        const cell = typeof args.cell === 'number' ? args.cell : undefined
        if (!path || cell === undefined) return null
        const before = await readOrNull(resolveInRoots(roots, path))
        if (before === null) return null
        const nb = parseNotebook(before)
        const after = editNotebook(nb, {
          cell,
          mode: (str(args, 'mode') || 'replace') as NotebookEditMode,
          source: typeof args.source === 'string' ? args.source : undefined,
          cellType: typeof args.cell_type === 'string' ? args.cell_type : undefined
        })
        // Diff the CELL VIEW, not the JSON. What lands on disk is a reshuffled JSON
        // document whose diff is mostly escaping and punctuation — the same wall of
        // noise that read_file renders as cells precisely to avoid. Diffing the
        // rendered view shows the change as a person reads the notebook, and matches
        // what read_file already showed them.
        return [
          bounded(
            path,
            diffLines(renderNotebook(nb, { path }), renderNotebook(after, { path })),
            {}
          )
        ]
      }

      case 'apply_patch': {
        if (typeof args.patch !== 'string') return null
        const previews: FileDiffPreview[] = []
        for (const op of parsePatch(args.patch)) {
          if (op.type === 'add') {
            previews.push(previewOf(op.path, null, op.content))
            continue
          }
          if (op.type === 'delete') {
            const before = await readOrNull(resolveInRoots(roots, op.path))
            previews.push(previewOf(op.path, before, null))
            continue
          }
          const before = await readOrNull(resolveInRoots(roots, op.path))
          if (before === null) return null
          let after = before
          for (const hunk of op.hunks) after = resolveEdit(after, hunk.oldText, hunk.newText).content
          if (op.moveTo && op.moveTo !== op.path) {
            // A move is one change to the reader ("this file became that file"), not
            // a delete plus an unrelated add, so it is previewed as the destination
            // carrying the edit, annotated with where it came from.
            previews.push(bounded(op.moveTo, diffLines(before, after), { renamedFrom: op.path }))
          } else {
            previews.push(previewOf(op.path, before, after))
          }
        }
        return previews
      }

      default:
        return null
    }
  } catch {
    // A preview is never a gate: if the change cannot be modelled, the approval card
    // simply shows no diff and the tool runs (and fails, if it was going to) exactly
    // as it would have.
    return null
  }
}
