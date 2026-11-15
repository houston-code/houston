import { describe, it, expect, vi } from 'vitest'
import { resolve } from 'node:path'
import type { Conversation } from '@shared/agent'
import { MAX_IMPORT_BYTES, type ImportedConversation } from '@shared/conversation-io'
import { importChatFile } from './tui-import'

const CWD = resolve('/proj')
const exported = JSON.stringify({
  title: 'From elsewhere',
  workspace: '/somewhere/else',
  providerId: 'anthropic',
  model: 'claude',
  messages: [{ role: 'user', content: 'hello' }]
})

function saver() {
  const saved: Array<{ data: ImportedConversation; workspace: string }> = []
  const save = (data: ImportedConversation, workspace: string): Conversation => {
    saved.push({ data, workspace })
    return {
      id: 'new-id',
      title: data.title ?? 'Imported',
      workspace,
      providerId: data.providerId ?? '',
      model: data.model ?? '',
      createdAt: 0,
      updatedAt: 0,
      messages: data.messages
    }
  }
  return { saved, save }
}

describe('importChatFile', () => {
  it('saves a JSON export as a new chat in the session folder, never the one the file names', () => {
    const s = saver()
    const out = importChatFile(CWD, 'chat.json', { save: s.save, size: () => 10, read: () => exported })
    expect(s.saved[0].workspace).toBe(CWD)
    expect(out).toMatchObject({ id: 'new-id', title: 'From elsewhere', textOnly: false })
    expect(out.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('refuses a file over the size cap without reading it', () => {
    const read = vi.fn(() => exported)
    expect(() =>
      importChatFile(CWD, 'big.json', { save: saver().save, size: () => MAX_IMPORT_BYTES + 1, read })
    ).toThrow(/too large/)
    expect(read).not.toHaveBeenCalled()
  })

  it('names a missing file, and passes on a malformed one without saving', () => {
    const missing = Object.assign(new Error('nope'), { code: 'ENOENT' })
    expect(() =>
      importChatFile(CWD, 'gone.json', {
        save: saver().save,
        size: () => {
          throw missing
        }
      })
    ).toThrow(/no such file/)
    const s = saver()
    expect(() => importChatFile(CWD, 'bad.json', { save: s.save, size: () => 5, read: () => '{"x":1}' })).toThrow()
    expect(s.saved).toEqual([])
  })
})
