import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chordTable,
  createKeybindingStore,
  describeBindings,
  ensureKeybindingsFile,
  feedChord,
  flushChord,
  keybindingsPath,
  keybindingsTemplate,
  keypressName,
  normalizeKeyName,
  parseChord,
  parseKeybindings,
  prettyKeys,
  stripJsonComments,
  EMPTY_BINDINGS,
  MAX_FILE_BYTES,
  type ChordOut,
  type Held,
  type KeyBindings
} from './tui-keybindings'

describe('normalizeKeyName', () => {
  it('spells control keys one way, whatever the file wrote', () => {
    for (const k of ['ctrl-k', 'Ctrl+K', 'control-k', 'C-k', 'CTRL-k']) expect(normalizeKeyName(k)).toBe('ctrl-k')
  })

  it('spells alt keys, keeping the case of the character', () => {
    expect(normalizeKeyName('alt-x')).toBe('alt-x')
    expect(normalizeKeyName('meta-x')).toBe('alt-x')
    expect(normalizeKeyName('M-x')).toBe('alt-x')
    expect(normalizeKeyName('option+x')).toBe('alt-x')
    expect(normalizeKeyName('alt-shift-x')).toBe('alt-X')
  })

  it('names the keys that have names', () => {
    expect(normalizeKeyName('Enter')).toBe('enter')
    expect(normalizeKeyName('return')).toBe('enter')
    expect(normalizeKeyName('esc')).toBe('escape')
    expect(normalizeKeyName('shift-tab')).toBe('shift-tab')
    expect(normalizeKeyName('shift-enter')).toBe('shift-enter')
    expect(normalizeKeyName('alt-enter')).toBe('alt-enter')
    expect(normalizeKeyName('PgUp')).toBe('pageup')
    expect(normalizeKeyName('page-down')).toBe('pagedown')
    expect(normalizeKeyName('ctrl-left')).toBe('ctrl-left')
    expect(normalizeKeyName('F5')).toBe('f5')
    expect(normalizeKeyName('alt-backspace')).toBe('alt-backspace')
  })

  it('maps keys a terminal sends as another key to that key', () => {
    expect(normalizeKeyName('ctrl-i')).toBe('tab')
    expect(normalizeKeyName('ctrl-m')).toBe('enter')
    expect(normalizeKeyName('ctrl-h')).toBe('backspace')
    expect(normalizeKeyName('ctrl-/')).toBe('ctrl-_')
    expect(normalizeKeyName('ctrl-6')).toBe('ctrl-^')
    expect(normalizeKeyName('ctrl-space')).toBe('ctrl-space')
    expect(normalizeKeyName('ctrl-[')).toBe('escape')
  })

  it('refuses keys a terminal cannot send or tell apart', () => {
    for (const k of ['ctrl-shift-k', 'ctrl-alt-k', 'shift-f5', 'ctrl-tab', 'hyper-k', 'ctrl-', '', 'ctrl-shift-up', 'f13', 'ab']) {
      expect(normalizeKeyName(k)).toBeNull()
    }
  })

  it('takes single characters as they are', () => {
    expect(normalizeKeyName('q')).toBe('q')
    expect(normalizeKeyName('shift-q')).toBe('Q')
    expect(normalizeKeyName('space')).toBe('space')
    expect(normalizeKeyName('alt-space')).toBe('alt-space')
    expect(normalizeKeyName('-')).toBe('-')
  })
})

describe('parseChord', () => {
  it('splits a chord on spaces', () => {
    expect(parseChord('ctrl-x ctrl-e')).toEqual(['ctrl-x', 'ctrl-e'])
    expect(parseChord('  C-x   k ')).toEqual(['ctrl-x', 'k'])
  })

  it('refuses a chord with a bad key or too many keys', () => {
    expect(parseChord('ctrl-x nope')).toBeNull()
    expect(parseChord('a b c d e')).toBeNull()
    expect(parseChord('   ')).toBeNull()
  })
})

describe('stripJsonComments', () => {
  it('drops line and block comments and trailing commas', () => {
    const text = '// head\n{ /* a */ "composer": { "ctrl-t": "transcript", // why\n }, }'
    expect(JSON.parse(stripJsonComments(text))).toEqual({ composer: { 'ctrl-t': 'transcript' } })
  })

  it('leaves comment-like text inside strings alone', () => {
    expect(JSON.parse(stripJsonComments('{"a": "http://x /* y */", "b": "q\\"//"}'))).toEqual({
      a: 'http://x /* y */',
      b: 'q"//'
    })
  })
})

describe('parseKeybindings', () => {
  it('reads each context, a chord, null and a command', () => {
    const { bindings, problems } = parseKeybindings(
      JSON.stringify({
        composer: { 'ctrl-t': 'transcript', 'ctrl-x ctrl-k': 'kill-line', 'ctrl-g': null, 'alt-r': 'command:review' },
        picker: { 'ctrl-n': 'down' },
        transcript: { d: 'page-down' }
      })
    )
    expect(problems).toEqual([])
    expect(bindings.composer.get('ctrl-t')).toEqual({ kind: 'action', name: 'transcript' })
    expect(bindings.composer.get('ctrl-x ctrl-k')).toEqual({ kind: 'action', name: 'kill-line' })
    expect(bindings.composer.get('ctrl-g')).toEqual({ kind: 'unbind' })
    expect(bindings.composer.get('alt-r')).toEqual({ kind: 'command', name: 'review' })
    expect(bindings.picker.get('ctrl-n')).toEqual({ kind: 'action', name: 'down' })
    expect(bindings.transcript.get('d')).toEqual({ kind: 'action', name: 'page-down' })
  })

  it('accepts the commented template, which binds nothing', () => {
    const { bindings, problems } = parseKeybindings(keybindingsTemplate())
    expect(problems).toEqual([])
    expect(bindings.composer.size + bindings.picker.size + bindings.transcript.size).toBe(0)
  })

  it('reports each bad entry and keeps the good ones', () => {
    const { bindings, problems } = parseKeybindings(
      JSON.stringify({
        composer: {
          'ctrl-t': 'transcript',
          'ctrl-shift-q': 'submit',
          a: 'submit',
          'ctrl-y': 'fly',
          'ctrl-o': 42,
          'ctrl-r': 'command:bad name!'
        },
        picker: { 'ctrl-p': 'command:review', j: 'down' },
        window: {},
        transcript: []
      })
    )
    expect(bindings.composer.size).toBe(1)
    expect(bindings.picker.size).toBe(0)
    expect(problems).toEqual([
      'composer: "ctrl-shift-q" is not a key the terminal can send',
      'composer: "a" would stop you typing that character; use a key with ctrl or alt',
      'composer: "ctrl-y": unknown action "fly" (see /keybindings for the list)',
      'composer: "ctrl-o": the action must be a string, or null to unbind the key',
      'composer: "ctrl-r": "command:bad name!" is not a command name',
      'picker: "ctrl-p": a command can only be bound in the composer',
      'picker: "j" would stop you typing that character; use a key with ctrl or alt',
      '"window" is not a context (use composer, picker or transcript)',
      'transcript: expected an object of "key": "action" entries'
    ])
  })

  it('reports a file that is not JSON, or not an object, and binds nothing', () => {
    const bad = parseKeybindings('{ "composer": ')
    expect(bad.problems[0]).toMatch(/^not valid JSON/)
    expect(bad.bindings).toBe(EMPTY_BINDINGS)
    expect(parseKeybindings('[1]').problems).toEqual(['expected an object with "composer", "picker" or "transcript" in it'])
    expect(parseKeybindings('').problems).toEqual([])
  })

  it('ignores $schema and comment keys', () => {
    expect(parseKeybindings('{"$schema": "x", "// note": 1}').problems).toEqual([])
  })

  it('strips control characters from what it echoes back', () => {
    const { problems } = parseKeybindings(JSON.stringify({ composer: { 'ctrl-t': 'x\u001b[31m' } }))
    expect(problems[0]).not.toContain('\u001b')
  })

  it('refuses an oversized file without parsing it', () => {
    const { problems } = parseKeybindings(' '.repeat(MAX_FILE_BYTES + 1))
    expect(problems[0]).toMatch(/larger than/)
  })

  it('reads at most 200 entries per context', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 250; i++) many[`f${(i % 12) + 1} f${(Math.floor(i / 12) % 12) + 1} f${Math.floor(i / 144) + 1}`] = 'submit'
    expect(Object.keys(many)).toHaveLength(250)
    const { bindings, problems } = parseKeybindings(JSON.stringify({ composer: many }))
    expect(problems).toEqual(['composer: only the first 200 entries are read'])
    expect(bindings.composer.size).toBe(200)
  })
})

/** Feed names through the chord layer; values are the names, to see what passes. */
function run(bindings: KeyBindings, ctx: 'composer' | 'picker' | 'transcript', names: Array<string | null>) {
  const t = chordTable(bindings, ctx)
  let held: Held<string | null>[] = []
  const out: ChordOut<string | null>[] = []
  for (const name of names) {
    const r = feedChord(t, held, { name, value: name })
    held = r.held
    out.push(...r.out)
  }
  return { out, held, flush: () => flushChord(t, held) }
}

const show = (outs: ChordOut<string | null>[]): string[] =>
  outs.map((o) => (o.kind === 'pass' ? `pass:${o.value}` : `bound:${o.keys}`))

describe('the chord layer', () => {
  const b = parseKeybindings(
    JSON.stringify({ composer: { 'ctrl-t': 'transcript', 'ctrl-x ctrl-k': 'kill-line', 'ctrl-q ctrl-w ctrl-e': 'undo', 'ctrl-q': 'redo' } })
  ).bindings

  it('passes keys with no binding through untouched', () => {
    expect(show(run(b, 'composer', ['ctrl-a', null, 'up']).out)).toEqual(['pass:ctrl-a', 'pass:null', 'pass:up'])
  })

  it('fires a single-key binding at once', () => {
    expect(show(run(b, 'composer', ['ctrl-t']).out)).toEqual(['bound:ctrl-t'])
  })

  it('holds the first key of a chord, then fires the chord', () => {
    const r = run(b, 'composer', ['ctrl-x'])
    expect(r.out).toEqual([])
    expect(r.held.map((h) => h.name)).toEqual(['ctrl-x'])
    expect(show(run(b, 'composer', ['ctrl-x', 'ctrl-k']).out)).toEqual(['bound:ctrl-x ctrl-k'])
  })

  it('keeps the built-in Ctrl-X Ctrl-E chord', () => {
    expect(show(run(b, 'composer', ['ctrl-x', 'ctrl-e']).out)).toEqual(['bound:ctrl-x ctrl-e'])
  })

  // With any binding set, Ctrl-X Ctrl-P stopped expanding a paste and moved Up instead.
  it('keeps the built-in Ctrl-X Ctrl-P chord, which expands a paste', () => {
    const r = run(b, 'composer', ['ctrl-x', 'ctrl-p']).out
    expect(show(r)).toEqual(['bound:ctrl-x ctrl-p'])
    expect(r[0]).toMatchObject({ action: { kind: 'action', name: 'expand-paste' } })
  })

  it('lets the held keys go as typed when the chord does not complete', () => {
    expect(show(run(b, 'composer', ['ctrl-x', 'ctrl-a']).out)).toEqual(['pass:ctrl-x', 'pass:ctrl-a'])
    // …including when the next key starts a chord of its own.
    const r = run(b, 'composer', ['ctrl-x', 'ctrl-x', 'ctrl-k'])
    expect(show(r.out)).toEqual(['pass:ctrl-x', 'bound:ctrl-x ctrl-k'])
  })

  it('a key that is both bound and a chord start waits, then fires alone on timeout or a mismatch', () => {
    const waiting = run(b, 'composer', ['ctrl-q'])
    expect(waiting.out).toEqual([])
    expect(show(waiting.flush())).toEqual(['bound:ctrl-q'])
    expect(show(run(b, 'composer', ['ctrl-q', 'ctrl-a']).out)).toEqual(['bound:ctrl-q', 'pass:ctrl-a'])
    expect(show(run(b, 'composer', ['ctrl-q', 'ctrl-w', 'ctrl-e']).out)).toEqual(['bound:ctrl-q ctrl-w ctrl-e'])
    // Two keys into a three-key chord, then a stray: the longest bound start fires.
    expect(show(run(b, 'composer', ['ctrl-q', 'ctrl-w', 'ctrl-a']).out)).toEqual(['bound:ctrl-q', 'pass:ctrl-w', 'pass:ctrl-a'])
  })

  it('text ends a chord: the held keys go first, then the text', () => {
    expect(show(run(b, 'composer', ['ctrl-x', null]).out)).toEqual(['pass:ctrl-x', 'pass:null'])
  })

  it('null unbinds a built-in chord, so its keys pass on their own', () => {
    // Ctrl-X starts two built-in chords: both go before it is a key of its own again.
    const off = parseKeybindings(JSON.stringify({ composer: { 'ctrl-x ctrl-e': null, 'ctrl-x ctrl-p': null } })).bindings
    expect(show(run(off, 'composer', ['ctrl-x', 'ctrl-e']).out)).toEqual(['pass:ctrl-x', 'pass:ctrl-e'])
    // One of them unbound: that chord does nothing, and the other still works.
    const one = parseKeybindings(JSON.stringify({ composer: { 'ctrl-x ctrl-e': null } })).bindings
    expect(run(one, 'composer', ['ctrl-x', 'ctrl-e']).out).toEqual([
      { kind: 'bound', action: { kind: 'unbind' }, keys: 'ctrl-x ctrl-e' }
    ])
    expect(show(run(one, 'composer', ['ctrl-x', 'ctrl-p']).out)).toEqual(['bound:ctrl-x ctrl-p'])
  })

  it('an unbound key comes out as a binding that does nothing', () => {
    const off = parseKeybindings(JSON.stringify({ composer: { 'ctrl-g': null } })).bindings
    const r = run(off, 'composer', ['ctrl-g'])
    expect(r.out).toEqual([{ kind: 'bound', action: { kind: 'unbind' }, keys: 'ctrl-g' }])
  })

  it('a timeout with nothing held flushes nothing', () => {
    expect(run(b, 'composer', []).flush()).toEqual([])
  })
})

describe('keypressName', () => {
  it('names readline keypresses the way the file spells them', () => {
    expect(keypressName({ name: 'n', ctrl: true, sequence: '\x0e' })).toBe('ctrl-n')
    expect(keypressName({ name: 'return', sequence: '\r' })).toBe('enter')
    expect(keypressName({ name: 'up' })).toBe('up')
    expect(keypressName({ name: 'up', ctrl: true })).toBe('ctrl-up')
    expect(keypressName({ name: 'tab', shift: true })).toBe('shift-tab')
    expect(keypressName({ name: 'escape' })).toBe('escape')
    expect(keypressName({ name: 'j', sequence: 'j' })).toBe('j')
    expect(keypressName({ name: 'x', meta: true, sequence: '\x1bx' })).toBe('alt-x')
    expect(keypressName({ name: 'f5' })).toBe('f5')
    expect(keypressName({ sequence: '\x1b[999~' })).toBeNull()
  })
})

describe('describeBindings and prettyKeys', () => {
  it('lists the user bindings per context for the overlay', () => {
    const b = parseKeybindings(
      JSON.stringify({ composer: { 'ctrl-x ctrl-k': 'kill-line', 'ctrl-g': null, 'alt-r': 'command:review' }, transcript: { d: 'page-down' } })
    ).bindings
    expect(describeBindings(b)).toEqual([
      '  composer:',
      '    Ctrl-X Ctrl-K      kill-line',
      '    Ctrl-G             unbound',
      '    Alt-r              /review',
      '  transcript:',
      '    d                  page-down'
    ])
    expect(describeBindings(EMPTY_BINDINGS)).toEqual([])
  })

  it('writes key names as people do', () => {
    expect(prettyKeys('ctrl-x ctrl-e')).toBe('Ctrl-X Ctrl-E')
    expect(prettyKeys('shift-tab')).toBe('Shift-Tab')
    expect(prettyKeys('pageup')).toBe('PageUp')
    expect(prettyKeys('f5')).toBe('F5')
    expect(prettyKeys('space')).toBe('Space')
    expect(prettyKeys('alt-x')).toBe('Alt-x')
    expect(prettyKeys('ctrl-_')).toBe('Ctrl-_')
  })
})

describe('the keybindings file', () => {
  it('lives in ~/.houston', () => {
    expect(keybindingsPath('/home/u')).toBe(join('/home/u', '.houston', 'keybindings.json'))
  })

  it('/keybindings creates it with the template once, owner-only, and never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-'))
    try {
      const path = join(dir, '.houston', 'keybindings.json')
      expect(ensureKeybindingsFile(path)).toEqual({ created: true })
      expect(readFileSync(path, 'utf8')).toBe(keybindingsTemplate())
      writeFileSync(path, '{"composer": {}}')
      expect(ensureKeybindingsFile(path)).toEqual({ created: false })
      expect(readFileSync(path, 'utf8')).toBe('{"composer": {}}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createKeybindingStore', () => {
  function store(files: Array<string | null>) {
    const reports: string[][] = []
    let onChange: ((file: string | null) => void) | null = null
    let i = 0
    const s = createKeybindingStore({
      path: '/h/.houston/keybindings.json',
      read: () => files[Math.min(i++, files.length - 1)],
      watch: (_dir, cb) => {
        onChange = cb
        return () => {}
      },
      report: (p) => reports.push(p)
    })
    return { s, reports, change: (f: string | null) => onChange?.(f) }
  }

  it('without a file binds nothing and reports nothing', () => {
    const { s, reports } = store([null])
    expect(s.get()).toBe(EMPTY_BINDINGS)
    expect(reports).toEqual([])
  })

  it('reports problems once, and again only when they change', () => {
    const bad = '{"composer": {"ctrl-t": "fly"}}'
    const worse = '{"composer": {"ctrl-t": "fly", "ctrl-y": "flap"}}'
    const { s, reports } = store([bad, bad, worse, '{}'])
    expect(reports).toHaveLength(1)
    s.reload()
    expect(reports).toHaveLength(1)
    s.reload()
    expect(reports).toHaveLength(2)
    expect(s.problems()).toHaveLength(2)
    s.reload()
    expect(s.problems()).toEqual([])
    expect(reports).toHaveLength(2)
  })

  it('picks up a change to the file', async () => {
    const { s, change } = store(['{}', '{"composer": {"ctrl-t": "transcript"}}'])
    expect(s.get().composer.size).toBe(0)
    change('other.json')
    change('keybindings.json')
    await new Promise((r) => setTimeout(r, 150))
    expect(s.get().composer.size).toBe(1)
    s.close()
  })

  // With no ~/.houston at launch the watch failed once and was never tried again, so
  // edits to the file /keybindings then created were never picked up.
  it('starts watching on a reload when the directory could not be watched at launch', async () => {
    let dirExists = false
    let onChange: ((file: string | null) => void) | null = null
    let reads = 0
    const s = createKeybindingStore({
      path: '/h/.houston/keybindings.json',
      read: () => (reads++ < 2 ? null : '{"composer": {"ctrl-t": "transcript"}}'),
      watch: (_dir, cb) => {
        if (!dirExists) return null
        onChange = cb
        return () => {}
      },
      report: () => {}
    })
    expect(onChange).toBeNull()
    dirExists = true // /keybindings created the file, and its directory
    s.reload()
    expect(onChange).not.toBeNull()
    onChange!('keybindings.json')
    await new Promise((r) => setTimeout(r, 150))
    expect(s.get().composer.size).toBe(1)
    s.close()
  })

  it('reports an unreadable file instead of throwing', () => {
    const reports: string[][] = []
    createKeybindingStore({
      path: '/x',
      read: () => {
        throw Object.assign(new Error('nope'), { code: 'EACCES' })
      },
      watch: () => null,
      report: (p) => reports.push(p)
    })
    expect(reports).toEqual([['could not be read (EACCES)']])
  })
})
