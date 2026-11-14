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

/** A front-matter value: a scalar, a list, or a one-level map of scalars. */
export type FrontmatterValue = string | string[] | Record<string, string>

export interface StructuredFrontmatter {
  fields: Record<string, FrontmatterValue>
  body: string
}

/** The front-matter block's lines and the body after it, or null when there is none. */
function splitBlock(text: string): { lines: string[]; body: string } | null {
  const normalised = text.replace(/\r\n/g, '\n')
  if (!normalised.startsWith('---\n')) return null
  const end = normalised.indexOf('\n---', 3)
  if (end === -1) return null
  const afterClose = normalised.indexOf('\n', end + 1)
  return {
    lines: normalised.slice(4, end).split('\n'),
    body: (afterClose === -1 ? '' : normalised.slice(afterClose + 1)).trim()
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** `[a, "b c"]` as a list; anything else stays a scalar. */
function scalarOrInlineList(raw: string): string | string[] {
  const v = raw.trim()
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean)
  }
  return stripQuotes(v)
}

/**
 * The richer front matter the Agent Skills format uses: besides flat `key: value`
 * lines, a key may hold an indented list (`- item` lines, or `[a, b]` inline), a
 * one-level map of `sub: value` lines (`metadata:`), or a `>`/`|` block scalar.
 * Still no YAML dependency: deeper nesting is not part of the format and is
 * ignored. Keys are lowercased, as in {@link parseFrontmatter}; map keys are kept as
 * written.
 */
export function parseStructuredFrontmatter(text: string): StructuredFrontmatter {
  const split = splitBlock(text)
  if (!split) return { fields: {}, body: text.trim() }
  const { lines, body } = split
  const fields: Record<string, FrontmatterValue> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    i++
    if (!m || indentOf(line) > 0 || line.trimStart().startsWith('#')) continue
    const key = m[1].toLowerCase()
    const rest = m[2].trim()
    // The indented lines that belong to this key.
    const nested: string[] = []
    while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > 0 || /^-\s/.test(lines[i]))) {
      nested.push(lines[i])
      i++
    }
    const inner = nested.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
      const parts = inner.map((l) => l.trim())
      fields[key] = rest.startsWith('>') ? parts.join(' ') : parts.join('\n')
      continue
    }
    if (rest !== '') {
      fields[key] = scalarOrInlineList(rest)
      continue
    }
    if (inner.length && inner.every((l) => /^-\s*/.test(l.trim()))) {
      fields[key] = inner.map((l) => stripQuotes(l.trim().replace(/^-\s*/, '').trim())).filter(Boolean)
      continue
    }
    const map: Record<string, string> = {}
    for (const l of inner) {
      const kv = /^([^:#]+?)\s*:\s*(.*)$/.exec(l.trim())
      if (kv) map[stripQuotes(kv[1].trim())] = stripQuotes(kv[2].trim())
    }
    fields[key] = inner.length ? map : ''
  }
  return { fields, body }
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Whether a front-matter `disabled:` value switches a skill, command or agent off
 * (`true`/`yes`/`on`/`1`, any case). Settings > Customize writes `disabled: true`.
 */
export function isDisabledFlag(value: string | undefined): boolean {
  return value !== undefined && /^(true|yes|on|1)$/i.test(value.trim())
}
