/**
 * Messages sent while the chat is busy wait in its queue. Each entry remembers the
 * settings it was sent with, so the queue panel can show its mode and model badges,
 * plus any one-off override the user picked for that message alone (e.g. "send
 * this one with the small model").
 */
export function enqueue(chat, text, override = {}) {
  const entry = { text, settings: { ...chat.settings, ...override } }
  chat.queue.push(entry)
  return entry
}

/** Delete a waiting message: the x on its badge in the queue panel. */
export function removeQueued(chat, index) {
  chat.queue = chat.queue.filter((_, i) => i !== index)
}

/** What the queue panel shows for each waiting message. */
export function queueBadges(chat) {
  return chat.queue.map((e) => `${e.text} [${e.settings.mode}, ${e.settings.model}]`)
}
