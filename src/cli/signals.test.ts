import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The signal path end to end, against a real process: the in-process tests drive the
// handlers with a fake `process`, which can't show that Node's default (exit on the
// spot, skipping every `finally`) is really overridden. This bundles the CLI the way
// scripts/build-cli.mjs does, runs `houston -p --json` against a loopback model that
// starts a reply and never finishes it, and signals the child mid-turn.

const root = resolve(__dirname, '../..')
const MODEL = 'mock-model'

let dir = ''
let cli = ''
let server: http.Server
let baseUrl = ''
/** Resolves on the first chat-completion request, i.e. once the turn is live. */
let streaming: Promise<void>
let markStreaming: () => void = () => {}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'houston-signals-'))
  cli = join(dir, 'houston-cli.cjs')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  await build({
    absWorkingDir: root,
    entryPoints: ['src/cli/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: cli,
    define: { __HOUSTON_VERSION__: JSON.stringify(pkg.version) },
    alias: { '@shared': join(root, 'src/shared') },
    external: ['supports-color'],
    logLevel: 'silent'
  })
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 0,
        model: MODEL,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'working ' }, finish_reason: null }]
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      markStreaming()
      // Never finishes: only a signal ends this turn.
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}, 120_000)

afterAll(async () => {
  server?.closeAllConnections()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

interface Ran {
  code: number | null
  signal: NodeJS.Signals | null
  lines: Array<Record<string, unknown>>
  stderr: string
}

/** Run a headless `--json` turn and send it `signal` once the model is mid-reply. */
async function interrupt(signal: NodeJS.Signals): Promise<Ran> {
  const data = join(dir, `data-${signal}`)
  const ws = join(dir, `ws-${signal}`)
  mkdirSync(data, { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(
    join(data, 'settings.json'),
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          kind: 'openai-compatible',
          label: 'Mock',
          baseUrl,
          models: [{ id: MODEL }],
          defaultModel: MODEL,
          requiresKey: false,
          hasKey: false
        }
      ],
      selected: { providerId: 'mock', model: MODEL }
    })
  )
  streaming = new Promise<void>((r) => (markStreaming = r))
  const child: ChildProcess = spawn(process.execPath, [cli, '-p', 'say hi', '--json'], {
    cwd: ws,
    env: { ...process.env, HOUSTON_DATA_DIR: data, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()))
  child.stderr!.on('data', (c: Buffer) => (stderr += c.toString()))
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) =>
    child.on('exit', (code, sig) => r([code, sig]))
  )
  const early = exited.then(([code]) => {
    throw new Error(`houston exited (${code}) before the turn started:\n${stderr}`)
  })
  await Promise.race([streaming, early])
  early.catch(() => {})
  child.kill(signal)
  const [code, sig] = await exited
  const lines = stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { code, signal: sig, lines, stderr }
}

describe.skipIf(process.platform === 'win32')('a signalled headless run (real process)', () => {
  for (const [signal, exit] of [
    ['SIGTERM', 143],
    ['SIGINT', 130]
  ] as const) {
    it(
      `${signal}: cancels the turn, prints an aborted result line, and exits ${exit}`,
      async () => {
        const r = await interrupt(signal)
        // Exited on its own with the shell's 128+n, not killed by the signal's default.
        expect(r.signal, r.stderr).toBeNull()
        expect(r.code, r.stderr).toBe(exit)
        const result = r.lines.at(-1)
        expect(result).toMatchObject({
          type: 'result',
          status: 'aborted',
          stopReason: 'aborted',
          error: `interrupted by ${signal}`
        })
        expect(r.stderr).toContain(`interrupted (${signal})`)
      },
      60_000
    )
  }
})
