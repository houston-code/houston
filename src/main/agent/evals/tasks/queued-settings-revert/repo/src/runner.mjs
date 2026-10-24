/**
 * Runs a message to completion. `agent` is the model call; the runner records which
 * settings each run actually used, which the transcript shows under the reply.
 */
export async function runMessage(chat, text, agent, settings = chat.settings) {
  chat.busy = true
  try {
    const reply = await agent(text, settings)
    chat.runs.push({ text, mode: settings.mode, model: settings.model, reply })
    return reply
  } finally {
    chat.busy = false
  }
}

/** After a run ends, send the queued messages one by one, oldest first. */
export async function drainQueue(chat, agent) {
  const queue = chat.queue
  while (queue.length) {
    const entry = queue.shift()
    chat.setSettings(entry.settings)
    await runMessage(chat, entry.text, agent)
  }
}
