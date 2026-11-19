import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, Conversation } from '@shared/agent'
import {
  LOG_FOLD_MIN_BYTES,
  addUsage,
  createConversation,
  deleteConversation,
  flushConversation,
  flushOpenConversations,
  getConversation,
  listConversations,
  resetConversationListCache,
  resetConversationSearchCache,
  resetConversationWriteCache,
  setCompaction,
  setMessages,
  writeRewind
} from './conversations'
import { resetUserDataDir, setUserDataDir } from './userData'
import { recordRunningConversations, resetRunMarkers } from './runMarkers'

/**
 * The append-only log beside each chat's JSON file (see the layout note in
 * conversations.ts): a save writes only what changed, a reader applies the log on top
 * of the base, and nothing a crash or another writer leaves behind is applied twice
 * or dropped without its bytes being kept.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-conv-log-'))
  setUserDataDir(dir)
  resetAll()
})
afterEach(() => {
  resetUserDataDir()
  rmSync(dir, { recursive: true, force: true })
})

/** A fresh process: nothing remembered about any write or read. */
function resetAll(): void {
  resetConversationWriteCache()
  resetConversationListCache()
  resetConversationSearchCache()
}

const convDir = (): string => join(dir, 'conversations')
const base = (id: string): string => join(convDir(), `${id}.json`)
const log = (id: string): string => join(convDir(), `${id}.jsonl`)
const logLines = (id: string): Array<Record<string, unknown>> =>
  readFileSync(log(id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
const aside = (kind: string): string[] => readdirSync(convDir()).filter((f) => f.includes(`.jsonl.${kind}-`))
const stampOf = (path: string): string => {
  const st = statSync(path)
  return `${st.ino}:${st.mtimeMs}:${st.size}`
}

function chat(n: number, size = 20): { id: string; messages: ChatMessage[] } {
  const c = createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
  const messages: ChatMessage[] = []
  for (let i = 0; i < n; i++) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(size)}` })
  }
  setMessages(c.id, messages)
  // Fold, so the tests start from a chat whose JSON file is the whole chat.
  flushConversation(c.id)
  return { id: c.id, messages }
}

describe('saving to the log', () => {
  it('appends only the new messages and leaves the JSON file alone', () => {
    const { id, messages } = chat(50, 2000)
    const before = stampOf(base(id))
    messages.push({ role: 'user', content: 'one more' })
    setMessages(id, messages)
    expect(stampOf(base(id))).toBe(before)
    const [header, rec] = logLines(id)
    expect(header).toMatchObject({ houstonLog: 1, base: before })
    expect(header.hash).toBe(createHash('sha256').update(readFileSync(base(id))).digest('hex'))
    expect(rec.n).toBe(50)
    expect(rec.m).toEqual([{ role: 'user', content: 'one more' }])
    // A save is the size of what changed, not of the chat.
    expect(statSync(log(id)).size).toBeLessThan(1000)
    expect(getConversation(id)?.messages).toEqual(messages)
  })

  it('saves bookkeeping as changed fields only', () => {
    const { id, messages } = chat(5)
    addUsage(id, { inputTokens: 10, outputTokens: 5, cost: 0.5 })
    setCompaction(id, { cut: 2, summary: 'so far', anchor: 1 })
    setCompaction(id, null)
    const recs = logLines(id).slice(1)
    expect(recs).toHaveLength(3)
    for (const r of recs) expect(r).not.toHaveProperty('m')
    expect(recs[0].s).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, cost: 0.5 } })
    expect(recs[1].s).toEqual({ compaction: { cut: 2, summary: 'so far', anchor: 1 } })
    expect(recs[2]).toEqual({ d: ['compaction'] })
    const got = getConversation(id)
    expect(got?.usage).toMatchObject({ cost: 0.5 })
    expect(got?.compaction).toBeUndefined()
    expect(got?.messages).toEqual(messages)
  })

  it('catches an earlier message changed in place, and a message inserted before the last', () => {
    const { id, messages } = chat(10)
    messages[3].content = 'edited in place'
    setMessages(id, messages)
    expect(logLines(id).at(-1)?.n).toBe(3)
    messages.splice(9, 0, { role: 'user', content: 'note' })
    setMessages(id, messages)
    expect(logLines(id).at(-1)?.n).toBe(9)
    resetAll()
    expect(getConversation(id)?.messages).toEqual(messages)
  })

  it('writes nothing when nothing changed', () => {
    const { id } = chat(3)
    setCompaction(id, { cut: 1, summary: 's', anchor: 0 })
    const size = statSync(log(id)).size
    setCompaction(id, { cut: 1, summary: 's', anchor: 0 })
    expect(statSync(log(id)).size).toBe(size)
  })

  it('shortens the log on a rewind and keeps going from there', () => {
    const { id, messages } = chat(8)
    writeRewind(id, { messages: messages.slice(0, 4), compaction: null, lastError: null, backup: null })
    expect(logLines(id).at(-1)).toMatchObject({ n: 4, m: [] })
    const next = [...messages.slice(0, 4), { role: 'user' as const, content: 'after the rewind' }]
    setMessages(id, next)
    resetAll()
    expect(getConversation(id)?.messages).toEqual(next)
  })
})

describe('resuming', () => {
  it('reads the JSON file and its log as one chat in a new process, and keeps appending', () => {
    const { id, messages } = chat(20)
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'assistant', content: `step ${i}` })
      setMessages(id, [...messages])
      addUsage(id, { inputTokens: i, outputTokens: 1, cost: 0.1 })
    }
    resetAll()
    const resumed = getConversation(id) as Conversation
    expect(resumed.messages).toEqual(messages)
    expect(resumed.usage?.outputTokens).toBe(5)
    expect(listConversations().find((c) => c.id === id)?.title).toBe(resumed.title)
    // The resumed process saves on top of what it read, by appending: its first save
    // compares against the messages it parsed, so the JSON file is not rewritten.
    const before = stampOf(base(id))
    setMessages(id, [...resumed.messages, { role: 'user', content: 'resumed' }])
    expect(stampOf(base(id))).toBe(before)
    expect(logLines(id).at(-1)).toMatchObject({ n: 25, m: [{ role: 'user', content: 'resumed' }] })
    resetAll()
    expect(getConversation(id)?.messages.at(-1)?.content).toBe('resumed')
    expect(getConversation(id)?.messages).toHaveLength(21 + 5 - 1 + 1)
  })

  it("picks up another process's appends before saving its own", () => {
    const { id, messages } = chat(4)
    setMessages(id, [...messages, { role: 'assistant', content: 'mine' }])
    // Another process holding the same chat appends a record straight to the log.
    appendFileSync(log(id), `${JSON.stringify({ s: { title: 'Renamed elsewhere' } })}\n`)
    addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
    resetAll()
    const got = getConversation(id)
    expect(got?.title).toBe('Renamed elsewhere')
    expect(got?.usage?.cost).toBe(1)
    expect(got?.messages.at(-1)?.content).toBe('mine')
  })
})

describe('a damaged log', () => {
  it('ignores a torn last record, then moves its bytes aside before the next save', () => {
    const { id, messages } = chat(4)
    setMessages(id, [...messages, { role: 'assistant', content: 'saved' }])
    // A crash mid-append: half a record, no newline.
    appendFileSync(log(id), '{"n":5,"m":[{"role":"user","cont')
    resetAll()
    expect(getConversation(id)?.messages.at(-1)?.content).toBe('saved')
    expect(aside('corrupt')).toEqual([])

    setMessages(id, [...messages, { role: 'assistant', content: 'saved' }, { role: 'user', content: 'next' }])
    const [kept] = aside('corrupt')
    expect(readFileSync(join(convDir(), kept), 'utf8')).toBe('{"n":5,"m":[{"role":"user","cont')
    expect(readFileSync(log(id), 'utf8').endsWith('\n')).toBe(true)
    resetAll()
    expect(getConversation(id)?.messages.map((m) => m.content).slice(-2)).toEqual(['saved', 'next'])
  })

  it('stops at an unreadable record and keeps it and everything after it', () => {
    const { id, messages } = chat(4)
    setMessages(id, [...messages, { role: 'assistant', content: 'good' }])
    appendFileSync(log(id), 'not json\n')
    appendFileSync(log(id), `${JSON.stringify({ s: { title: 'after the damage' } })}\n`)
    // A well-formed line that would break the chat is just as unreadable.
    resetAll()
    const got = getConversation(id)
    expect(got?.messages.at(-1)?.content).toBe('good')
    expect(got?.title).not.toBe('after the damage')

    addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
    const [kept] = aside('corrupt')
    expect(readFileSync(join(convDir(), kept), 'utf8')).toContain('after the damage')
    resetAll()
    expect(getConversation(id)?.usage?.cost).toBe(1)
  })

  it('refuses a record that would leave the chat without its fields', () => {
    const { id } = chat(2)
    addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
    appendFileSync(log(id), `${JSON.stringify({ d: ['title'] })}\n`)
    appendFileSync(log(id), `${JSON.stringify({ s: { messages: [] } })}\n`)
    resetAll()
    const got = getConversation(id)
    expect(typeof got?.title).toBe('string')
    expect(got?.messages).toHaveLength(2)
  })

  it('never lets a record replace the chat object\'s prototype', () => {
    const { id } = chat(2)
    addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
    appendFileSync(log(id), '{"s":{"__proto__":{"polluted":true}}}\n')
    resetAll()
    const got = getConversation(id) as unknown as Record<string, unknown>
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype)
    expect(got.polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('sets aside a log written for another version of the JSON file, never applying it', () => {
    const { id, messages } = chat(4)
    setMessages(id, [...messages, { role: 'assistant', content: 'only in the log' }])
    // An older Houston, which knows nothing of the log, rewrites the JSON file.
    const old = JSON.parse(readFileSync(base(id), 'utf8')) as Conversation
    writeFileSync(base(id), JSON.stringify({ ...old, title: 'Written by an older version' }))
    resetAll()
    const got = getConversation(id)
    expect(got?.title).toBe('Written by an older version')
    expect(got?.messages).toHaveLength(4)

    addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
    const [kept] = aside('orphan')
    expect(readFileSync(join(convDir(), kept), 'utf8')).toContain('only in the log')
    resetAll()
    expect(getConversation(id)).toMatchObject({ title: 'Written by an older version', usage: { cost: 1 } })
  })

  it('still applies the log after the profile is copied somewhere else', () => {
    const { id, messages } = chat(4)
    setMessages(id, [...messages, { role: 'assistant', content: 'in the log' }])
    const copy = mkdtempSync(join(tmpdir(), 'houston-conv-copy-'))
    try {
      // A copy keeps the bytes but not the inode, so the base's stamp no longer matches.
      cpSync(dir, copy, { recursive: true })
      setUserDataDir(copy)
      resetAll()
      expect(getConversation(id)?.messages.at(-1)?.content).toBe('in the log')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('quarantines the log with an unreadable JSON file', () => {
    const { id, messages } = chat(2)
    setMessages(id, [...messages, { role: 'user', content: 'x' }])
    writeFileSync(base(id), '{ broken')
    resetAll()
    expect(getConversation(id)).toBeNull()
    expect(existsSync(`${base(id)}.corrupt`)).toBe(true)
    expect(existsSync(`${log(id)}.corrupt`)).toBe(true)
    expect(existsSync(log(id))).toBe(false)
  })
})

describe('folding the log into the JSON file', () => {
  it('rewrites the JSON file whole once the log outgrows it, and starts a fresh log', () => {
    const { id, messages } = chat(4)
    const big = 'y'.repeat(64 * 1024)
    let folded = false
    for (let i = 0; i < 40 && !folded; i++) {
      messages.push({ role: 'assistant', content: `${i} ${big}` })
      const before = stampOf(base(id))
      setMessages(id, [...messages])
      folded = stampOf(base(id)) !== before
    }
    expect(folded).toBe(true)
    // The fold took everything, so there is no log until the next save.
    expect(existsSync(log(id))).toBe(false)
    const whole = JSON.parse(readFileSync(base(id), 'utf8')) as Conversation
    expect(whole.messages).toEqual(messages)
    // Never more than the fold budget, or the base, behind.
    expect(readFileSync(base(id)).length).toBeGreaterThan(LOG_FOLD_MIN_BYTES)

    messages.push({ role: 'user', content: 'after the fold' })
    setMessages(id, [...messages])
    expect(logLines(id)[0].base).toBe(stampOf(base(id)))
    resetAll()
    expect(getConversation(id)?.messages).toEqual(messages)
  })

  it('flushConversation leaves the JSON file alone as the whole chat', () => {
    const { id, messages } = chat(3)
    setMessages(id, [...messages, { role: 'assistant', content: 'latest' }])
    addUsage(id, { inputTokens: 1, outputTokens: 2, cost: 3 })
    const expected = getConversation(id)
    flushConversation(id)
    expect(existsSync(log(id))).toBe(false)
    expect(JSON.parse(readFileSync(base(id), 'utf8'))).toEqual(expected)
    // A no-op when there is nothing to fold.
    const st = stampOf(base(id))
    flushConversation(id)
    expect(stampOf(base(id))).toBe(st)
  })

  it('folds the log of every chat it wrote, not only the few it still remembers', () => {
    // More chats than the write cache holds, each with a log of its own.
    const chats = Array.from({ length: 6 }, () => chat(2))
    for (const c of chats) {
      c.messages.push({ role: 'assistant', content: `latest of ${c.id}` })
      setMessages(c.id, [...c.messages])
    }
    // A chat pushed out of the cache is folded then, without waiting for an exit the
    // schedule daemon never makes.
    const first = JSON.parse(readFileSync(base(chats[0].id), 'utf8')) as Conversation
    expect(first.messages).toEqual(chats[0].messages)
    expect(existsSync(log(chats[0].id))).toBe(false)
    flushOpenConversations()
    expect(readdirSync(convDir()).filter((f) => f.endsWith('.jsonl'))).toEqual([])
    for (const c of chats) {
      expect((JSON.parse(readFileSync(base(c.id), 'utf8')) as Conversation).messages).toEqual(c.messages)
    }
  })

  it('keeps every chat this process is running, so their saves never push each other out', () => {
    // More chats running at once than the cache holds for idle ones: spawned sessions
    // beside their parent.
    const chats = Array.from({ length: 6 }, () => chat(2))
    const idle = chat(2)
    recordRunningConversations(chats.map((c) => c.id))
    try {
      for (const c of chats) {
        c.messages.push({ role: 'assistant', content: `step 1 of ${c.id}` })
        setMessages(c.id, [...c.messages])
      }
      const bases = chats.map((c) => stampOf(base(c.id)))
      // Each step after the first only appends: no save reads another chat back in, or
      // folds another chat's log by rewriting its JSON file.
      for (let n = 2; n <= 3; n++) {
        for (const c of chats) {
          c.messages.push({ role: 'assistant', content: `step ${n} of ${c.id}` })
          setMessages(c.id, [...c.messages])
        }
      }
      expect(chats.map((c) => stampOf(base(c.id)))).toEqual(bases)
      expect(chats.every((c) => existsSync(log(c.id)))).toBe(true)
      // An idle chat is still let go as before.
      setMessages(idle.id, [...idle.messages, { role: 'user', content: 'more' }])
      for (const c of chats) setMessages(c.id, [...c.messages, { role: 'user', content: 'more' }])
      expect(existsSync(log(idle.id))).toBe(false)
    } finally {
      recordRunningConversations([])
      resetRunMarkers()
    }
    for (const c of chats) expect(getConversation(c.id)?.messages.at(-1)?.content).toBe('more')
  })

  it('leaves the log of a chat pushed out of the cache alone once another process wrote it', () => {
    const chats = Array.from({ length: 5 }, () => chat(2))
    const [a] = chats
    setMessages(a.id, [...a.messages, { role: 'assistant', content: 'mine' }])
    // Another process appends to the same log before this one lets go of the chat.
    appendFileSync(log(a.id), `${JSON.stringify({ s: { title: 'Renamed elsewhere' } })}\n`)
    for (const c of chats.slice(1)) setMessages(c.id, [...c.messages, { role: 'user', content: 'more' }])
    expect(existsSync(log(a.id))).toBe(true)
    resetAll()
    expect(getConversation(a.id)).toMatchObject({ title: 'Renamed elsewhere' })
    expect(getConversation(a.id)?.messages.at(-1)?.content).toBe('mine')
  })

  it('leaves the log to another process that is running the chat', () => {
    const { id, messages } = chat(3)
    setMessages(id, [...messages, { role: 'assistant', content: 'latest' }])
    mkdirSync(join(dir, 'runs'), { recursive: true })
    writeFileSync(join(dir, 'runs', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, conversations: [id] }))
    flushConversation(id)
    expect(existsSync(log(id))).toBe(true)
    rmSync(join(dir, 'runs'), { recursive: true, force: true })
    flushConversation(id)
    expect(existsSync(log(id))).toBe(false)
  })

  it('folds a log this process did not write', () => {
    const { id, messages } = chat(3)
    setMessages(id, [...messages, { role: 'assistant', content: 'latest' }])
    resetAll()
    flushConversation(id)
    expect(existsSync(log(id))).toBe(false)
    expect((JSON.parse(readFileSync(base(id), 'utf8')) as Conversation).messages.at(-1)?.content).toBe('latest')
  })
})

describe('files from before the log', () => {
  it('reads a JSON file the previous version wrote, and appends to it', () => {
    // As the previous store wrote it: shell fields first, then the messages, no log.
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const previous = {
      id,
      schemaVersion: 2,
      title: 'From before',
      workspace: '/ws',
      providerId: 'p',
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      usage: { inputTokens: 1, outputTokens: 1, cost: 1 },
      messages: [{ role: 'user', content: 'old message' }]
    }
    createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    writeFileSync(base(id), JSON.stringify(previous))
    expect(getConversation(id)).toMatchObject({ title: 'From before', messages: previous.messages })

    setMessages(id, [...(previous.messages as ChatMessage[]), { role: 'assistant', content: 'new reply' }])
    // Appended, not rewritten: the old file is the log's base.
    expect(JSON.parse(readFileSync(base(id), 'utf8'))).toEqual(previous)
    expect(logLines(id)[1]).toMatchObject({ n: 1, m: [{ role: 'assistant', content: 'new reply' }] })
    resetAll()
    expect(getConversation(id)?.messages.map((m) => m.content)).toEqual(['old message', 'new reply'])
    expect(getConversation(id)?.usage?.cost).toBe(1)
  })

  it('rewrites a file from an older schema whole on its first save', () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    createConversation({ workspace: '/ws', providerId: 'p', model: 'm' })
    writeFileSync(
      base(id),
      JSON.stringify({ id, title: 'v0', workspace: '/ws', providerId: 'p', model: 'm', createdAt: 1, updatedAt: 2, messages: [] })
    )
    addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
    expect(existsSync(log(id))).toBe(false)
    expect(JSON.parse(readFileSync(base(id), 'utf8'))).toMatchObject({ schemaVersion: 2, usage: { cost: 1 } })
  })
})

it('deleting a chat removes its log', () => {
  const { id, messages } = chat(2)
  setMessages(id, [...messages, { role: 'user', content: 'x' }])
  expect(existsSync(log(id))).toBe(true)
  deleteConversation(id)
  expect(existsSync(log(id))).toBe(false)
  expect(existsSync(base(id))).toBe(false)
})

it('deleting a chat removes the log pieces set aside beside it', () => {
  const { id, messages } = chat(2)
  setMessages(id, [...messages, { role: 'assistant', content: 'secret text in the log' }])
  // An older Houston rewrites the JSON file, so the next save sets the log aside.
  const old = JSON.parse(readFileSync(base(id), 'utf8')) as Conversation
  writeFileSync(base(id), JSON.stringify({ ...old, title: 'Written by an older version' }))
  resetAll()
  addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
  // And a torn record, set aside on the save after it.
  appendFileSync(log(id), '{"n":2,"m":[{"role":"user","cont')
  resetAll()
  addUsage(id, { inputTokens: 1, outputTokens: 1, cost: 1 })
  expect(aside('orphan')).toHaveLength(1)
  expect(aside('corrupt')).toHaveLength(1)
  const other = chat(1)
  deleteConversation(id)
  expect(readdirSync(convDir()).filter((f) => f.startsWith(id))).toEqual([])
  expect(existsSync(base(other.id))).toBe(true)
})

it('attachments in appended messages go to the media folder, and are pruned when dropped', () => {
  const { id, messages } = chat(2)
  const image = { mediaType: 'image/png', data: Buffer.from('png bytes').toString('base64') }
  setMessages(id, [...messages, { role: 'user', content: 'look', images: [image] }])
  expect(readFileSync(log(id), 'utf8')).not.toContain(image.data)
  const media = join(convDir(), `${id}.media`)
  expect(readdirSync(media)).toHaveLength(1)
  resetAll()
  expect(getConversation(id)?.messages.at(-1)?.images).toEqual([image])
  // A resumed process drops the image when its message goes.
  setMessages(id, getConversation(id)!.messages)
  setMessages(id, messages)
  expect(existsSync(media)).toBe(false)
})
