/**
 * The Settings pages by id and label, apart from their components so lightweight
 * callers (the slash-command mapping) can name a page without loading them all.
 */
export const PAGE_LABELS = {
  models: 'Providers & Models',
  agent: 'Agent Behavior',
  tools: 'Tools',
  mcp: 'MCP Servers',
  hooks: 'Hooks',
  workspace: 'Workspace',
  general: 'General',
  appearance: 'Appearance',
  keyboard: 'Keyboard',
  permissions: 'Permissions',
  about: 'About'
} as const

/** Settings pages shown in the left-hand nav. */
export type TabId = keyof typeof PAGE_LABELS

/**
 * The page a typed word names: its id or its label, ignoring case and `&`
 * (`/settings permissions`, `/settings agent behavior`). Null when it names none.
 */
export function pageForWords(words: string): TabId | null {
  const norm = (s: string): string => s.toLowerCase().replace(/&/g, ' ').replace(/\s+/g, ' ').trim()
  const w = norm(words)
  if (!w) return null
  for (const [id, label] of Object.entries(PAGE_LABELS) as Array<[TabId, string]>) {
    if (w === id || w === norm(label)) return id
  }
  return null
}
