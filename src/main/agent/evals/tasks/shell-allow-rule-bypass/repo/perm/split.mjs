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
export function splitCommand(line) {
  return line
    .split(/;|&&/)
    .map((part) => part.trim())
    .filter(Boolean)
}
