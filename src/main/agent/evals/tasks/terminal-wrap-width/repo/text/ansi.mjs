/** SGR color/style codes, the only escapes our UI text carries. They take no columns. */
export const ANSI = /\x1b\[[0-9;]*m/g

export function stripAnsi(text) {
  return text.replace(ANSI, '')
}
