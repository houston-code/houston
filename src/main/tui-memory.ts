import type { MemoryRecord, MemoryStoreScope } from '@shared/memoryTypes'
import type { AppSettings } from '@shared/types'
import { MemoryError, type MemoryStore } from './agent/memoryStore'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * /memory in the terminal: the same review surface as the desktop's Settings >
 * Memory page (list, read, edit, pin, forget with undo, on/off), over the same
 * store. Memories are numbered as /memory lists them: this repository's first, then
 * the all-projects ones. In the desktop app, /memory opens that page instead.
 */

export type MemoryAction =
  | { op: 'list' }
  | { op: 'show' | 'edit' | 'forget' | 'pin' | 'unpin'; index: number }
  | { op: 'undo' }
  | { op: 'enable'; on: boolean }
  | { op: 'folder' }
  | { op: 'usage' }

export const MEMORY_USAGE =
  'usage: /memory   ·   /memory show|edit|pin|unpin|forget <n>   ·   /memory undo   ·   /memory on|off   ·   /memory folder'

/** Parse the argument of /memory. Bare command → list. */
export function parseMemoryAction(arg: string): MemoryAction {
  const [verb, n] = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!verb || verb === 'list') return { op: 'list' }
  if (verb === 'undo') return { op: 'undo' }
  if (verb === 'on' || verb === 'off') return { op: 'enable', on: verb === 'on' }
  if (verb === 'folder') return { op: 'folder' }
  const op =
    verb === 'show' || verb === 'view'
      ? 'show'
      : verb === 'edit'
        ? 'edit'
        : verb === 'pin'
          ? 'pin'
          : verb === 'unpin'
            ? 'unpin'
            : verb === 'forget' || verb === 'rm' || verb === 'remove' || verb === 'delete'
              ? 'forget'
              : null
  const index = Number.parseInt(n ?? '', 10)
  if (op && Number.isInteger(index) && index >= 1) return { op, index }
  return { op: 'usage' }
}

export interface MemoryCommandDeps {
  /** The store for the terminal's folder; absent where memory isn't wired. */
  store?: () => MemoryStore
  getSettings: () => AppSettings
  updateSettings?: (patch: Partial<AppSettings>) => void
  /** Open text in the user's editor; null when they cancel or no editor is set. */
  editText?: (initial: string) => Promise<string | null>
  out: (text: string) => void
}

/** What /memory remembers between commands in one terminal session: the last forgotten memory, for undo. */
export interface MemoryCommandState {
  lastForgotten?: { scope: MemoryStoreScope; id: string; name: string }
}

/** Memories in /memory's numbering. */
export function numberedMemories(store: MemoryStore): MemoryRecord[] {
  return [...(store.currentRepoKey !== undefined ? store.list('repo') : []), ...store.list('global')]
}

// Memory text was written by the agent or by hand: keep escape sequences out of the terminal.
const clean = (s: string): string => stripControlChars(s)

export function renderMemoryList(store: MemoryStore, enabled: boolean, paint: Painter): string {
  const all = numberedMemories(store)
  const lines: string[] = [paint(`Memory ${enabled ? '' : paint('(off: /memory on to use it)', 'yellow')}`.trimEnd(), 'bold')]
  if (all.length === 0) {
    lines.push(paint('  Nothing saved yet. The agent saves what a later session should know as it works.', 'dim'))
  }
  let i = 0
  const section = (title: string, items: MemoryRecord[]): void => {
    if (!items.length) return
    lines.push(`  ${paint(title, 'dim')}`)
    for (const m of items) {
      i++
      const pin = m.pinned ? paint(' (pinned)', 'cyan') : ''
      lines.push(`  ${String(i).padStart(2)}) ${paint(clean(m.name), 'cyan')} ${paint(`[${m.type}]`, 'dim')}${pin}`)
      lines.push(`      ${clean(m.description)}`)
    }
  }
  if (store.currentRepoKey !== undefined) {
    section(`This repository (${clean(store.currentRepoLabel ?? '')})`, store.list('repo'))
  }
  section('All projects', store.list('global'))
  lines.push(paint(MEMORY_USAGE, 'dim'))
  return `${lines.join('\n')}\n`
}

export async function runMemoryCommand(
  action: MemoryAction,
  deps: MemoryCommandDeps,
  state: MemoryCommandState,
  paint: Painter
): Promise<void> {
  const say = (text: string, tone: 'dim' | 'yellow' = 'dim'): void => deps.out(paint(`· ${text}\n`, tone))
  if (action.op === 'usage') return deps.out(paint(`${MEMORY_USAGE}\n`, 'yellow'))
  if (action.op === 'enable') {
    if (!deps.updateSettings) return say('changing settings is unavailable here')
    deps.updateSettings({ memoryEnabled: action.on })
    return say(
      action.on
        ? 'memory on: the agent sees and saves memories from your next message'
        : 'memory off: the agent runs without memories from your next message (nothing is deleted)'
    )
  }
  if (!deps.store) return say('memory is unavailable here')
  const store = deps.store()
  if (action.op === 'folder') return say(`memories live in ${store.root}`)
  if (action.op === 'list') return deps.out(renderMemoryList(store, deps.getSettings().memoryEnabled !== false, paint))

  try {
    if (action.op === 'undo') {
      const last = state.lastForgotten
      if (!last) return say('nothing to undo')
      const back = await store.restore(last.scope, last.id)
      state.lastForgotten = undefined
      return back ? say(`restored ${clean(back.name)}`) : say(`${clean(last.name)} can no longer be restored`, 'yellow')
    }
    const all = numberedMemories(store)
    const m = all[action.index - 1]
    if (!m) {
      return say(`no memory #${action.index} (there ${all.length === 1 ? 'is 1' : `are ${all.length}`}; /memory lists them)`, 'yellow')
    }
    switch (action.op) {
      case 'show':
        return deps.out(
          `${paint(clean(m.name), 'bold')} ${paint(`[${m.type}, ${m.scope === 'repo' ? 'this repository' : 'all projects'}, updated ${m.updated.slice(0, 10)}]`, 'dim')}\n` +
            `${clean(m.description)}\n\n${clean(m.body)}\n`
        )
      case 'pin':
      case 'unpin':
        await store.setPinned(m.scope, m.id, action.op === 'pin')
        return say(`${action.op === 'pin' ? 'pinned' : 'unpinned'} ${clean(m.name)}`)
      case 'forget': {
        const removed = await store.remove(m.scope, m.id)
        if (!removed) return say(`${clean(m.name)} was already gone`, 'yellow')
        state.lastForgotten = { scope: m.scope, id: m.id, name: m.name }
        return say(`forgot ${clean(m.name)} (/memory undo brings it back)`)
      }
      case 'edit': {
        if (!deps.editText) return say('editing needs an editor: set $EDITOR (or $VISUAL) and try again')
        const edited = await deps.editText(m.body)
        if (edited === null) return say('not changed')
        if (edited.trim() === m.body.trim()) return say('no changes')
        await store.save({
          scope: m.scope,
          id: m.id,
          type: m.type,
          name: m.name,
          description: m.description,
          body: edited,
          origin: 'user',
          expectedUpdated: m.updated
        })
        return say(`saved ${clean(m.name)}`)
      }
    }
  } catch (err) {
    if (err instanceof MemoryError) return say(err.message, 'yellow')
    throw err
  }
}
