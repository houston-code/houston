import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, type ChatMessage } from '@shared/agent'
import { itemsFromMessages, type UserItem } from './items'

describe('itemsFromMessages', () => {
  it('flags the compaction summary turn so it renders as markdown', () => {
    const summary = '- did a thing\n- learned a fact'
    const messages: ChatMessage[] = [
      { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` },
      { role: 'assistant', content: 'Understood.' }
    ]
    const items = itemsFromMessages(messages)
    const user = items.find((i): i is UserItem => i.kind === 'user')
    expect(user?.isSummary).toBe(true)
  })

  it('leaves ordinary user turns unflagged', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '- a normal message with a dash' }]
    const items = itemsFromMessages(messages)
    const user = items.find((i): i is UserItem => i.kind === 'user')
    expect(user?.isSummary).toBeUndefined()
  })
})
