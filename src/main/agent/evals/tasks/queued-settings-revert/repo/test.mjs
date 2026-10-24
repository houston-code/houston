import assert from 'node:assert/strict'
import { createChat } from './src/chat.mjs'
import { enqueue, queueBadges } from './src/queue.mjs'
import { drainQueue, runMessage } from './src/runner.mjs'
import { memoryStore } from './src/store.mjs'

const agent = async (text, settings) => `${settings.model} replied to ${text}`

// The reported bug: switch to plan mode while a message waits, then let it run.
{
  const store = memoryStore()
  const chat = createChat('c1', store)
  const first = runMessage(chat, 'refactor auth', agent)
  enqueue(chat, 'and add tests')
  chat.setSettings({ mode: 'plan' }) // the user tightens the chat while it's busy
  await first
  await drainQueue(chat, agent)

  assert.deepEqual(
    chat.runs.map((r) => `${r.text}: ${r.mode}`),
    ['refactor auth: full-auto', 'and add tests: plan'],
    'the queued message must run in the mode the chat is in when it runs'
  )
  assert.equal(chat.settings.mode, 'plan', 'running the queue must not undo the switch to plan')
  assert.equal(store.data.c1.mode, 'plan', 'nor write the old mode back to the settings file')
}

console.log('ok')
