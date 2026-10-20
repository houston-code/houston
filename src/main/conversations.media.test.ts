import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, Conversation } from '@shared/agent'

/**
 * The conversation store keeps attachment bytes in `<id>.media/` beside the JSON
 * (see conversationMedia.ts). These tests run the real fs paths through a temp
 * userData dir: what lands on disk, what comes back from getConversation, and that
 * the read-modify-write helpers, fork, delete, and legacy inline files all keep
 * images intact.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
// Distinct, valid-looking base64 payloads (the store never decodes them as images).
const PNG = Buffer.from('\x89PNG\r\n\x1a\nfirst image bytes').toString('base64')
const PNG2 = Buffer.from('\x89PNG\r\n\x1a\nsecond image bytes').toString('base64')
const PDF = Buffer.from('%PDF-1.7 tiny document').toString('base64')

const convDir = (): string => join(state.userData, 'conversations')
const jsonOf = (id: string): Conversation => JSON.parse(readFileSync(join(convDir(), `${id}.json`), 'utf8'))
const mediaFiles = (id: string): string[] => {
  const d = join(convDir(), `${id}.media`)
  return existsSync(d) ? readdirSync(d).sort() : []
}

function messagesWithImages(): ChatMessage[] {
  return [
    { role: 'user', content: 'look at this', images: [{ mediaType: 'image/png', data: PNG }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.png' } }] },
    {
      role: 'tool',
      content: 'read a.png',
      toolCallId: 'c1',
      images: [{ mediaType: 'image/png', data: PNG2 }],
      documents: [{ mediaType: 'application/pdf', data: PDF, name: 'spec.pdf' }]
    }
  ]
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-conv-media-'))
  mkdirSync(convDir(), { recursive: true })
})

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
  vi.resetModules()
})

describe('conversation media store', () => {
  it('writes attachment bytes beside the JSON and keeps only references inline', async () => {
    const { createConversation, setMessages } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(conv.id, messagesWithImages())

    const raw = readFileSync(join(convDir(), `${conv.id}.json`), 'utf8')
    expect(raw).not.toContain(PNG)
    expect(raw).not.toContain(PDF)
    const onDisk = jsonOf(conv.id)
    const userImg = onDisk.messages[0].images![0] as unknown as Record<string, unknown>
    expect(userImg.data).toBeUndefined()
    expect(userImg.mediaRef).toMatch(/^[0-9a-f]{64}\.png$/)
    const doc = onDisk.messages[2].documents![0] as unknown as Record<string, unknown>
    expect(doc.mediaRef).toMatch(/\.pdf$/)
    expect(doc.name).toBe('spec.pdf')

    const files = mediaFiles(conv.id)
    expect(files).toHaveLength(3)
    const file = join(convDir(), `${conv.id}.media`, userImg.mediaRef as string)
    expect(readFileSync(file).toString('base64')).toBe(PNG)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('gives getConversation the bytes back, exactly as they were saved', async () => {
    const { createConversation, setMessages, getConversation } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    const messages = messagesWithImages()
    setMessages(conv.id, messages)
    expect(getConversation(conv.id)!.messages).toEqual(messages)
  })

  it('stores a repeated image once', async () => {
    const { createConversation, setMessages } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    const img = { mediaType: 'image/png', data: PNG }
    setMessages(conv.id, [
      { role: 'user', content: 'one', images: [img] },
      { role: 'user', content: 'two', images: [{ ...img }] }
    ])
    expect(mediaFiles(conv.id)).toHaveLength(1)
  })

  it('keeps images through helpers that rewrite the file without loading them', async () => {
    const { createConversation, setMessages, setGeneratedTitle, getConversation } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(conv.id, messagesWithImages())
    expect(setGeneratedTitle(conv.id, 'Generated')).toBe(true)
    expect(mediaFiles(conv.id)).toHaveLength(3)
    expect(getConversation(conv.id)!.messages[0].images![0].data).toBe(PNG)
  })

  it('prunes files no message references any more, and the folder once empty', async () => {
    const { createConversation, setMessages } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(conv.id, messagesWithImages())
    setMessages(conv.id, [messagesWithImages()[0]])
    expect(mediaFiles(conv.id)).toHaveLength(1)
    setMessages(conv.id, [{ role: 'user', content: 'text only' }])
    expect(existsSync(join(convDir(), `${conv.id}.media`))).toBe(false)
  })

  it('loads a legacy file with inline base64 and moves it out on the next save', async () => {
    const legacy: Conversation = {
      id: ID,
      schemaVersion: 1,
      title: 'Old',
      workspace: '/ws',
      providerId: 'p',
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: 'user', content: 'hi', images: [{ mediaType: 'image/png', data: PNG }] }]
    }
    writeFileSync(join(convDir(), `${ID}.json`), JSON.stringify(legacy), 'utf8')
    const { getConversation, setGeneratedTitle } = await import('./conversations')
    expect(getConversation(ID)!.messages[0].images![0].data).toBe(PNG)

    setGeneratedTitle(ID, 'Renamed')
    expect(readFileSync(join(convDir(), `${ID}.json`), 'utf8')).not.toContain(PNG)
    expect(mediaFiles(ID)).toHaveLength(1)
    expect(getConversation(ID)!.messages[0].images![0].data).toBe(PNG)
  })

  it('drops an image whose file is gone instead of failing the whole chat', async () => {
    const { createConversation, setMessages, getConversation } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(conv.id, [
      { role: 'user', content: 'two images', images: [{ mediaType: 'image/png', data: PNG }, { mediaType: 'image/png', data: PNG2 }] }
    ])
    const [first] = mediaFiles(conv.id)
    rmSync(join(convDir(), `${conv.id}.media`, first))
    const loaded = getConversation(conv.id)!
    expect(loaded.messages[0].content).toBe('two images')
    expect(loaded.messages[0].images).toHaveLength(1)
    expect(loaded.messages[0].images![0].data.length).toBeGreaterThan(0)
  })

  it('never follows a tampered reference outside the media folder', async () => {
    writeFileSync(join(state.userData, 'secret.png'), 'outside')
    const tampered = {
      id: ID,
      schemaVersion: 2,
      title: 'Tampered',
      workspace: '/ws',
      providerId: 'p',
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', mediaRef: '../../secret.png' }] }]
    }
    writeFileSync(join(convDir(), `${ID}.json`), JSON.stringify(tampered), 'utf8')
    const { getConversation } = await import('./conversations')
    expect(getConversation(ID)!.messages[0].images).toEqual([])
  })

  it('deletes the media folder with the conversation', async () => {
    const { createConversation, setMessages, deleteConversation } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(conv.id, messagesWithImages())
    deleteConversation(conv.id)
    expect(existsSync(join(convDir(), `${conv.id}.media`))).toBe(false)
  })

  it('gives a fork its own copy of the media', async () => {
    const { createConversation, setMessages, forkConversation, deleteConversation, getConversation } = await import(
      './conversations'
    )
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(conv.id, messagesWithImages())
    const fork = forkConversation(conv.id)!
    deleteConversation(conv.id)
    expect(mediaFiles(fork.id)).toHaveLength(3)
    expect(getConversation(fork.id)!.messages[0].images![0].data).toBe(PNG)
  })

  it('keeps the media folder out of the conversation list', async () => {
    const { createConversation, setMessages, listConversations } = await import('./conversations')
    const conv = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    setMessages(conv.id, messagesWithImages())
    expect(listConversations().map((m) => m.id)).toEqual([conv.id])
  })
})
