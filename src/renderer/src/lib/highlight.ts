import hljs from 'highlight.js/lib/common'

/**
 * Syntax highlighting for the Files panel's code preview. Uses highlight.js's
 * "common" bundle (~37 mainstream languages) and resolves the language from the
 * file extension only — never auto-detection, which guesses wildly on short or
 * ambiguous files. hljs escapes its input, so the returned HTML is safe to inject.
 */

/** File extension → highlight.js language id (restricted to the common bundle). */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', json5: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff', lua: 'lua', r: 'r'
}

/** Extensionless filenames worth highlighting, keyed by lowercased basename. */
const NAME_LANG: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile'
}

/** Skip highlighting past this size — tokenizing megabytes would jank the pane. */
export const MAX_HIGHLIGHT_BYTES = 100 * 1024

/** The highlight.js language id for a path, or null if we shouldn't highlight it. */
export function languageForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  const lang = dot > 0 ? EXT_LANG[base.slice(dot + 1)] : NAME_LANG[base]
  return lang && hljs.getLanguage(lang) ? lang : null
}

/**
 * Highlight `text` as the language inferred from `path`, returning hljs token
 * HTML — or null when the language is unknown, the file is too large, or hljs
 * throws (the caller then renders the raw text unchanged).
 */
export function highlightFile(path: string, text: string): string | null {
  if (text.length > MAX_HIGHLIGHT_BYTES) return null
  const lang = languageForPath(path)
  if (!lang) return null
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
}
