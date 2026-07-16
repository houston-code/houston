/**
 * Minimal YAML-ish front-matter parser, shared by the agent and skill loaders.
 * Handles the common `key: value` block delimited by `---` lines at the top of a
 * Markdown file; everything after the closing `---` is the body. No external YAML
 * dependency — just the flat string fields these configs use.
 */

export interface ParsedFrontmatter {
  data: Record<string, string>
  body: string
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  // Normalise CRLF so the delimiter regex is simple.
  const normalised = text.replace(/\r\n/g, '\n')
  if (!normalised.startsWith('---\n')) return { data: {}, body: text.trim() }

  // Search from index 3 (the opening line's newline), not 4: an EMPTY block ("---\n---")
  // has its closing "\n---" starting at index 3, so starting at 4 skipped it and leaked
  // the delimiters into the body. For a non-empty block index 4 isn't "-", so unchanged.
  const end = normalised.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text.trim() }

  const block = normalised.slice(4, end)
  // Body starts after the closing "---" line.
  const afterClose = normalised.indexOf('\n', end + 1)
  const body = afterClose === -1 ? '' : normalised.slice(afterClose + 1)

  const data: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (m) data[m[1].toLowerCase()] = stripQuotes(m[2].trim())
  }
  return { data, body: body.trim() }
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}
