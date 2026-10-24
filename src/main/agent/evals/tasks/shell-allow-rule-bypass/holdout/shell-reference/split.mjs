/**
 * The programs a shell command line would run, for the permission check.
 *
 * An allow rule approves one program ("npm test", "git status"), so a line is only
 * allowed if EVERY program in it is. That means returning each simple command the
 * shell would run:
 *
 *   - commands separated by `;`, `&&`, `||`, `|`, `&` or a newline (an `&` that is
 *     part of a redirection, as in `2>&1` or `&>`, separates nothing);
 *   - the commands inside command substitution, `$(...)` and backticks, and inside
 *     process substitution, `<(...)` and `>(...)`, wherever they appear in a word.
 *
 * Quoting decides what is literal. Inside single quotes nothing is special. Inside
 * double quotes separators are literal, but `$(...)` and backticks still run. A
 * backslash outside single quotes makes the next character literal.
 *
 * Each command comes back trimmed, with its quotes left as written.
 */
/** A line the shell couldn't parse: an unterminated quote or substitution. */
export class UnparseableCommand extends Error {}

export function splitCommand(line) {
  const out = []
  parseList(line, 0, null, out)
  return out
}

/**
 * Scan a command list from `i` until `close` (end of input, ")" or a backtick),
 * pushing each finished simple command to `out`. Returns the index of `close`.
 * Substitutions recurse, so the commands inside them are pushed too, and their text
 * stays part of the command that contains them.
 */
function parseList(s, i, close, out) {
  let cmd = ''
  const flush = () => {
    const c = cmd.trim()
    if (c) out.push(c)
    cmd = ''
  }
  while (i < s.length) {
    const ch = s[i]
    if (close && ch === close) {
      flush()
      return i
    }
    if (ch === '\\') {
      cmd += s.slice(i, i + 2)
      i += 2
    } else if (ch === "'") {
      const end = s.indexOf("'", i + 1)
      if (end === -1) throw new UnparseableCommand('unterminated single quote')
      cmd += s.slice(i, end + 1)
      i = end + 1
    } else if (ch === '"') {
      const end = parseDoubleQuoted(s, i + 1, out)
      cmd += s.slice(i, end + 1)
      i = end + 1
    } else if (ch === '`') {
      const end = parseList(s, i + 1, '`', out)
      cmd += s.slice(i, end + 1)
      i = end + 1
    } else if ((ch === '$' || ch === '<' || ch === '>') && s[i + 1] === '(') {
      const end = parseList(s, i + 2, ')', out)
      cmd += s.slice(i, end + 1)
      i = end + 1
    } else if (ch === ';' || ch === '\n') {
      flush()
      i++
    } else if (ch === '|') {
      flush()
      i += s[i + 1] === '|' ? 2 : 1
    } else if (ch === '&' && s[i + 1] === '&') {
      flush()
      i += 2
    } else if (ch === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) {
      cmd += ch // a redirection: 2>&1, >&2, &>
      i++
    } else if (ch === '&') {
      flush()
      i++
    } else {
      cmd += ch
      i++
    }
  }
  if (close) throw new UnparseableCommand(`unterminated ${close === ')' ? '$(' : '`'}`)
  flush()
  return i
}

/** Scan a double-quoted string from just after its opening quote; returns the closing quote's index. */
function parseDoubleQuoted(s, i, out) {
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"') return i
    if (ch === '\\') i += 2
    else if (ch === '`') i = parseList(s, i + 1, '`', out) + 1
    else if (ch === '$' && s[i + 1] === '(') i = parseList(s, i + 2, ')', out) + 1
    else i++
  }
  throw new UnparseableCommand('unterminated double quote')
}
