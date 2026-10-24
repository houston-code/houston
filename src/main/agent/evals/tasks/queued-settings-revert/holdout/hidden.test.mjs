import assert from 'node:assert/strict'
import { createChat } from './src/chat.mjs'
import { enqueue, queueBadges, removeQueued } from './src/queue.mjs'
import { drainQueue, runMessage } from './src/runner.mjs'
import { memoryStore } from './src/store.mjs'

const agent = async (text, settings) => `${settings.model} replied to ${text}`

// A one-off override applies to that message only, and is never saved to the chat.
{
  const store = memoryStore({ c2: { model: 'large' } })
  const chat = createChat('c2', store)
  chat.busy = true
  enqueue(chat, 'quick question', { model: 'small' })
  enqueue(chat, 'follow-up')
  chat.busy = false
  await drainQueue(chat, agent)

  assert.deepEqual(
    chat.runs.map((r) => `${r.text}: ${r.model}`),
    ['quick question: small', 'follow-up: large']
  )
  assert.equal(chat.settings.model, 'large')
  assert.equal(store.data.c2.model, 'large')
}

// The queue panel shows what each message will actually run with.
{
  const chat = createChat('c3', memoryStore())
  chat.busy = true
  enqueue(chat, 'one')
  enqueue(chat, 'two', { model: 'small' })
  chat.setSettings({ mode: 'auto-edit' })
  assert.deepEqual(queueBadges(chat), ['one [auto-edit, large]', 'two [auto-edit, small]'])
}
// A message deleted from the queue while an earlier one is running never runs, and
// one queued after that still does.
{
  const chat = createChat('c4', memoryStore())
  chat.busy = true
  enqueue(chat, 'first')
  enqueue(chat, 'second')
  enqueue(chat, 'third')
  chat.busy = false
  await drainQueue(chat, async (text, settings) => {
    if (text === 'first') {
      removeQueued(chat, 0) // the user deletes "second" while "first" runs
      enqueue(chat, 'fourth')
    }
    return `${settings.model} replied to ${text}`
  })
  assert.deepEqual(chat.runs.map((r) => r.text), ['first', 'third', 'fourth'], 'a deleted message ran, or a new one never did')
  assert.deepEqual(chat.queue, [])
}
console.log('ok')
