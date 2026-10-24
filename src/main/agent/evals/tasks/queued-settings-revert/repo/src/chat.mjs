/**
 * A chat and its settings. `mode` is the approval mode the user picked in the
 * composer; `model` is the chat's model. Every change is saved through `store`.
 */
export const DEFAULT_SETTINGS = Object.freeze({ mode: 'full-auto', model: 'large' })

export function createChat(id, store) {
  const chat = {
    id,
    settings: { ...DEFAULT_SETTINGS, ...store.load(id) },
    busy: false,
    queue: [],
    runs: [],
    setSettings(patch) {
      chat.settings = { ...chat.settings, ...patch }
      store.save(id, chat.settings)
    }
  }
  return chat
}
