import type { Painter } from './tui'

/**
 * Turn highlight.js token HTML into ANSI for the terminal. Kept free of any
 * highlight.js import so it's unit-testable without the dep: `highlightToHtml`
 * takes the hljs instance as a parameter, and the real instance is injected at
 * the entry point. `htmlToAnsi` is a pure HTML→ANSI mapper.
 */

/** Minimal hljs surface we call — satisfied by the real `highlight.js` default export. */
export interface HljsLike {
  getLanguage(name: string): unknown
  highlight(code: string, opts: { language: string; ignoreIllegals?: boolean }): { value: string }
}

/** Common fenced-code language tokens → highlight.js language ids. */
const FENCE_LANG: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', python: 'python', rb: 'ruby', ruby: 'ruby',
  go: 'go', rs: 'rust', rust: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cs: 'csharp', csharp: 'csharp',
  php: 'php', swift: 'swift', kt: 'kotlin', kotlin: 'kotlin',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  json: 'json', json5: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  html: 'xml', xml: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff',
  lua: 'lua', r: 'r', graphql: 'graphql', gql: 'graphql'
}

/** Normalize a fence language token to a highlight.js id, or null if unmapped. */
export function fenceLangToHljs(lang: string): string | null {
  return FENCE_LANG[lang.trim().toLowerCase()] ?? null
}

/**
 * Highlight `code` as `lang`, returning hljs token HTML — or null when the
 * language is unknown to hljs or highlighting throws (caller renders raw).
 */
export function highlightToHtml(hljs: HljsLike, lang: string, code: string): string | null {
  const id = fenceLangToHljs(lang)
  if (!id || !hljs.getLanguage(id)) return null
  try {
    return hljs.highlight(code, { language: id, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

/** Map a highlight.js token scope to one of the terminal's SGR styles. */
export function hljsStyleFor(className: string): Parameters<Painter>[1] | null {
  // Take the first `hljs-<scope>` class; hljs sometimes emits `hljs-title function_`.
  const m = /hljs-([a-z_]+)/.exec(className)
  const scope = m?.[1]
  switch (scope) {
    case 'keyword':
    case 'built_in':
    case 'literal':
    case 'type':
      return 'magenta'
    case 'string':
    case 'regexp':
    case 'char':
    case 'addition':
      return 'green'
    case 'comment':
    case 'quote':
    case 'deletion':
      return 'dim'
    case 'number':
    case 'symbol':
    case 'link':
      return 'cyan'
    case 'title':
    case 'section':
    case 'name':
      return 'blue'
    case 'attr':
    case 'attribute':
    case 'property':
    case 'variable':
    case 'params':
    case 'meta':
      return 'yellow'
    default:
      return null
  }
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'"
}

function unescapeHtml(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m)
}

/**
 * Convert highlight.js token HTML into an ANSI-colored string. Stack-based over
 * `<span class="hljs-…">`/`</span>`; text runs are colored by the innermost open
 * scope (flat coloring — good enough for a terminal). Entities are unescaped.
 */
export function htmlToAnsi(html: string, paint: Painter): string {
  let out = ''
  const stack: Array<Parameters<Painter>[1] | null> = []
  const token = /<span class="([^"]*)">|<\/span>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = token.exec(html))) {
    if (m[1] !== undefined) {
      stack.push(hljsStyleFor(m[1]))
    } else if (m[2] !== undefined) {
      const text = unescapeHtml(m[2])
      const style = stack.length ? stack[stack.length - 1] : null
      out += style ? paint(text, style) : text
    } else {
      stack.pop()
    }
  }
  return out
}
