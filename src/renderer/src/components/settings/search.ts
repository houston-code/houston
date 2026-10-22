/**
 * Settings search: a query matches a section when every word of it appears
 * somewhere in what the section is about: its rendered text (title, description,
 * labels, hints), its synonyms, its page's name, and the user's own values.
 * Matching ignores case, accents, and punctuation runs, and each query word may
 * match the start of or the inside of a word ("perm" finds "Permissions").
 */

/** Lowercase, strip accents, and collapse punctuation and whitespace to single spaces. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_\-–—/\\:;,.()[\]{}"'`|]+/g, ' ')
    .trim()
}

/** The words of a query, normalized. Empty for a blank query. */
export function queryTerms(query: string): string[] {
  const norm = normalizeForSearch(query)
  return norm ? norm.split(' ') : []
}

/** Whether every term occurs in the (already normalized) haystack. */
export function matchesTerms(terms: string[], haystack: string): boolean {
  return terms.length > 0 && terms.every((t) => haystack.includes(t))
}

/** Build one normalized haystack from the pieces a section is searched on. */
export function searchHaystack(parts: Array<string | undefined | null>): string {
  return normalizeForSearch(parts.filter(Boolean).join(' '))
}

/**
 * Highlight every occurrence of the query terms inside `root` with the CSS Custom
 * Highlight API (`::highlight(settings-search)`), skipping hidden subtrees. A no-op
 * where the API is missing (it is a progressive enhancement: the filtering itself
 * does not depend on it). Returns a cleanup that removes the highlight.
 */
export function highlightTerms(root: HTMLElement, query: string): () => void {
  const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  if (!registry || !HighlightCtor) return () => {}
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length === 0) {
    registry.delete('settings-search')
    return () => {}
  }
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || parent.closest('[hidden]')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').toLowerCase()
    for (const word of words) {
      for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + word.length)
        ranges.push(range)
      }
    }
  }
  registry.set('settings-search', new HighlightCtor(...ranges))
  return () => registry.delete('settings-search')
}
