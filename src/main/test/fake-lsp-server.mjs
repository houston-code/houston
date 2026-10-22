// A tiny language server for tests: speaks LSP over stdio with Content-Length framing
// and implements just enough to exercise Houston's client. Behavior is steered with
// environment variables so a test can make it slow, silent, crash, or answer with
// paths outside the workspace.
//
//   FAKE_LSP_DIAG_DELAY_MS   delay before publishing diagnostics (default 20)
//   FAKE_LSP_SILENT=1        never publish diagnostics
//   FAKE_LSP_CRASH_ON=<m>    exit(3) when a message with method <m> arrives
//   FAKE_LSP_OUTSIDE=<abs>   definition/references/rename also point at this path
//   FAKE_LSP_LOG=<abs>       append every received method to this file
//   FAKE_LSP_NO_VERSION=1    publish diagnostics without a version
//   FAKE_LSP_INIT_DELAY_MS   delay before answering initialize
//   FAKE_LSP_DEF_IMPORT=1    definition of an imported name answers with its import line
//                            first (as TypeScript's server does); asked there, the declaration
//   FAKE_LSP_STALE=1         on a change, first publish (unversioned) the verdict on the old text
//
// Diagnostics: every line containing ERROR yields an error, every line containing WARN
// yields a warning, at the column where the word starts.
import { Buffer } from 'node:buffer'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'

const env = process.env
const docs = new Map() // uri -> { text, version }
let buf = Buffer.alloc(0)

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) return
    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString('ascii'))
    const len = Number(m[1])
    if (buf.length < end + 4 + len) return
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString('utf8'))
    buf = buf.subarray(end + 4 + len)
    handle(msg)
  }
})

function wordAt(text, pos) {
  const line = text.split('\n')[pos.line] ?? ''
  let s = pos.character
  let e = pos.character
  while (s > 0 && /\w/.test(line[s - 1])) s--
  while (e < line.length && /\w/.test(line[e])) e++
  return line.slice(s, e)
}

function occurrences(word) {
  const out = []
  if (!word) return out
  const re = new RegExp(`\\b${word}\\b`, 'g')
  for (const [uri, d] of docs) {
    d.text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        out.push({ uri, range: { start: { line: i, character: m.index }, end: { line: i, character: m.index + word.length } } })
      }
    })
  }
  return out
}

function outsideLocation() {
  if (!env.FAKE_LSP_OUTSIDE) return []
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  return [{ uri: pathToFileURL(env.FAKE_LSP_OUTSIDE).href, range }]
}

function publish(uri) {
  if (env.FAKE_LSP_SILENT === '1') return
  const d = docs.get(uri)
  if (!d) return
  const version = d.version
  setTimeout(() => {
    const cur = docs.get(uri)
    if (!cur || cur.version !== version) return // superseded
    send({
      method: 'textDocument/publishDiagnostics',
      params: { uri, ...(env.FAKE_LSP_NO_VERSION === '1' ? {} : { version }), diagnostics: diagnosticsOf(cur.text) }
    })
  }, Number(env.FAKE_LSP_DIAG_DELAY_MS ?? 20))
}

function diagnosticsOf(text) {
    const diagnostics = []
    text.split('\n').forEach((line, i) => {
      for (const [word, severity, message] of [
        ['ERROR', 1, 'something is broken'],
        ['WARN', 2, 'something looks off']
      ]) {
        const at = line.indexOf(word)
        if (at >= 0) {
          diagnostics.push({
            range: { start: { line: i, character: at }, end: { line: i, character: at + word.length } },
            severity,
            source: 'fake',
            code: severity === 1 ? 'E1' : 'W1',
            message: `${message}: ${line.trim()}`
          })
        }
      }
    })
    return diagnostics
}

function symbolsIn(uri) {
  const d = docs.get(uri)
  if (!d) return []
  const out = []
  d.text.split('\n').forEach((line, i) => {
    const m = /function (\w+)/.exec(line)
    if (m) {
      const range = { start: { line: i, character: m.index + 9 }, end: { line: i, character: m.index + 9 + m[1].length } }
      out.push({ name: m[1], kind: 12, location: { uri, range } })
    }
  })
  return out
}

function handle(msg) {
  if (env.FAKE_LSP_LOG && msg.method) appendFileSync(env.FAKE_LSP_LOG, `${msg.method}\n`)
  if (env.FAKE_LSP_CRASH_ON && msg.method === env.FAKE_LSP_CRASH_ON) process.exit(3)
  const p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      if (env.FAKE_LSP_INIT_DELAY_MS && !msg.delayed) {
        setTimeout(() => handle({ ...msg, delayed: true }), Number(env.FAKE_LSP_INIT_DELAY_MS))
        return
      }
      return send({
        id: msg.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            renameProvider: true
          },
          serverInfo: { name: 'fake-lsp' }
        }
      })
    case 'initialized':
      // Ask the client for settings, as real servers do, and expect an answer.
      send({ id: 'cfg-1', method: 'workspace/configuration', params: { items: [{ section: 'fake' }] } })
      return
    case 'textDocument/didOpen':
      docs.set(p.textDocument.uri, { text: p.textDocument.text, version: p.textDocument.version })
      return publish(p.textDocument.uri)
    case 'textDocument/didChange': {
      const d = docs.get(p.textDocument.uri)
      if (!d) return
      // A verdict on the previous text that was already on its way out, unversioned.
      if (env.FAKE_LSP_STALE === '1') {
        send({ method: 'textDocument/publishDiagnostics', params: { uri: p.textDocument.uri, diagnostics: diagnosticsOf(d.text) } })
      }
      d.text = p.contentChanges[p.contentChanges.length - 1].text
      d.version = p.textDocument.version
      return publish(p.textDocument.uri)
    }
    case 'textDocument/didClose':
      docs.delete(p.textDocument.uri)
      return
    case 'textDocument/definition': {
      const d = docs.get(p.textDocument.uri)
      const word = d ? wordAt(d.text, p.position) : ''
      if (env.FAKE_LSP_DEF_IMPORT === '1' && d) {
        const lines = d.text.split('\n')
        const imp = lines.findIndex((l) => l.startsWith('import ') && new RegExp(`\\b${word}\\b`).test(l))
        if (imp >= 0 && imp !== p.position.line) {
          const col = lines[imp].indexOf(word)
          const range = { start: { line: imp, character: col }, end: { line: imp, character: col + word.length } }
          return send({ id: msg.id, result: [{ targetUri: p.textDocument.uri, targetRange: range, targetSelectionRange: range }] })
        }
      }
      const decl = occurrences(word).find((o) => {
        const line = docs.get(o.uri).text.split('\n')[o.range.start.line]
        return /function |const |let |class /.test(line)
      })
      return send({ id: msg.id, result: [...outsideLocation(), ...(decl ? [decl] : [])] })
    }
    case 'textDocument/references': {
      const d = docs.get(p.textDocument.uri)
      return send({ id: msg.id, result: [...outsideLocation(), ...occurrences(d ? wordAt(d.text, p.position) : '')] })
    }
    case 'textDocument/hover': {
      const d = docs.get(p.textDocument.uri)
      const word = d ? wordAt(d.text, p.position) : ''
      return send({ id: msg.id, result: word ? { contents: { kind: 'markdown', value: `\`\`\`ts\nfunction ${word}(): void\n\`\`\`\nDocs for ${word}.` } } : null })
    }
    case 'textDocument/documentSymbol':
      return send({ id: msg.id, result: symbolsIn(p.textDocument.uri) })
    case 'workspace/symbol': {
      const all = [...docs.keys()].flatMap(symbolsIn).filter((s) => s.name.includes(p.query ?? ''))
      return send({ id: msg.id, result: all })
    }
    case 'textDocument/rename': {
      const d = docs.get(p.textDocument.uri)
      const word = d ? wordAt(d.text, p.position) : ''
      if (!word) return send({ id: msg.id, error: { code: -32602, message: 'nothing to rename here' } })
      const changes = {}
      for (const o of [...occurrences(word), ...outsideLocation()]) {
        ;(changes[o.uri] ??= []).push({ range: o.range, newText: p.newName })
      }
      return send({ id: msg.id, result: { changes } })
    }
    case 'shutdown':
      return send({ id: msg.id, result: null })
    case 'exit':
      return process.exit(0)
    default:
      if (msg.id !== undefined && msg.method) send({ id: msg.id, error: { code: -32601, message: 'unhandled' } })
  }
}

