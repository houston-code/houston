import http from 'node:http'
import { contentText, type ChatMessage } from '../mock-provider'

/** The text a finished soak turn ends with; the turn number follows it. */
export const TURN_DONE = 'SOAK_TURN_FINISHED'
/** The prompt every soak turn starts with; the turn number follows it. */
export const TURN_PROMPT = 'SOAK TURN'
/** What a soak subagent's prompt starts with, so its requests can be told apart. */
const SUBAGENT_PROMPT = 'SOAK SUBAGENT'
/** How many tool calls a soak subagent makes before it reports. */
const SUBAGENT_STEPS = 3
/** Distinct screenshots in the soak workspace (shot0.png ...). */
export const SHOTS = 8

export interface SoakModelOptions {
  /** Tool calls per turn. */
  steps: number
  /** Dispatch a subagent on every this-many-th turn (0: never). */
  subagentEvery: number
  /** Override the reply to a turn: return a tool call, or undefined for the scripted one. */
  override?: (turn: number, step: number) => { name: string; args: Record<string, unknown> } | undefined
}

export interface SoakModel {
  baseUrl: string
  model: string
  /** Chat-completion requests served so far. */
  requests(): number
  /** The most tool results any one request carried (how long the history got). */
  peakToolResults(): number
  /** Subagent reports delivered. */
  subagentReports(): number
  close(): Promise<void>
}

/**
 * A loopback OpenAI-compatible model that plays a long, heavy agent session: each turn
 * makes `steps` tool calls with large results (a 2000-line file window, a shell command
 * near the output cap, a search, a screenshot, a file write, now and then a subagent),
 * streaming a little text before each, then ends with `TURN_DONE-<turn>`.
 *
 * Steps are counted here per turn rather than read back from the history: mid-turn
 * compaction can summarize the turn's own messages away, after which the history no
 * longer says how many calls were made. A request without tools (the chat title, a
 * compaction summary) gets a short text reply.
 */
export function startSoakModel(opts: SoakModelOptions): Promise<SoakModel> {
  const model = 'soak-model'
  let requests = 0
  let peakToolResults = 0
  let reports = 0
  let seenTurn = 0
  const stepsDone = new Map<number, number>()
  const subagentSteps = new Map<string, number>()

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'soak' }] }))
      return
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      requests++
      const parsed = JSON.parse(body || '{}') as { messages?: ChatMessage[]; tools?: unknown[] }
      const messages = parsed.messages ?? []
      const hasTools = (parsed.tools?.length ?? 0) > 0
      peakToolResults = Math.max(peakToolResults, messages.filter((m) => m.role === 'tool').length)
      const userTexts = messages.filter((m) => m.role === 'user').map((m) => contentText(m.content))
      const subagent = userTexts.find((t) => t.includes(SUBAGENT_PROMPT))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
        res.write(
          `data: ${JSON.stringify({ id: 'soak', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      }
      const call = (id: string, name: string, args: Record<string, unknown>): void => {
        send({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        send({}, 'tool_calls')
      }
      send({ role: 'assistant', content: '' })
      if (!hasTools) {
        send({ content: 'Summary of earlier work: read files, ran commands, wrote notes.' })
        send({}, 'stop')
      } else if (subagent && !userTexts.some((t) => t.includes(TURN_PROMPT))) {
        // A subagent's own loop: a few reads, then its report.
        const done = subagentSteps.get(subagent) ?? 0
        if (done >= SUBAGENT_STEPS) {
          reports++
          send({ content: `Report: looked through big.ts. ${'Finding. '.repeat(200)}` })
          send({}, 'stop')
        } else {
          subagentSteps.set(subagent, done + 1)
          if (done === 1) call(`sub_${done}`, 'search_files', { pattern: `value${done * 31}` })
          else call(`sub_${done}`, 'read_file', { path: 'big.ts', offset: done * 4000 + 1, limit: 2000 })
        }
      } else {
        for (const t of userTexts) {
          const hit = new RegExp(`${TURN_PROMPT} (\\d+)`).exec(t)
          if (hit) seenTurn = Math.max(seenTurn, Number(hit[1]))
        }
        const turn = seenTurn
        const done = stepsDone.get(turn) ?? 0
        if (done >= opts.steps) {
          send({ content: `Turn finished. ${TURN_DONE}-${turn}` })
          send({}, 'stop')
        } else {
          stepsDone.set(turn, done + 1)
          for (let i = 0; i < 20; i++) send({ content: `Turn ${turn} step ${done}, thinking part ${i}. ` })
          const id = `call_${turn}_${done}`
          const forced = opts.override?.(turn, done)
          if (forced) call(id, forced.name, forced.args)
          else scripted(turn, done, opts, (name, args) => call(id, name, args))
        }
      }
      res.write(
        `data: ${JSON.stringify({ id: 'soak', object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } })}\n\n`
      )
      res.end('data: [DONE]\n\n')
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model,
        requests: () => requests,
        peakToolResults: () => peakToolResults,
        subagentReports: () => reports,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

/** The scripted tool call for step `step` of turn `turn`. */
function scripted(
  turn: number,
  step: number,
  opts: SoakModelOptions,
  call: (name: string, args: Record<string, unknown>) => void
): void {
  const n = turn * opts.steps + step
  switch (step % 6) {
    case 0:
      return call('read_file', { path: 'big.ts', offset: ((n * 97) % 30000) + 1, limit: 2000 })
    case 1:
      // Near the shell's 1 MB output cap, through whatever shell the platform uses.
      return call('run_shell', {
        command: `node -e "for (let i = 0; i < 40000; i++) console.log('line of output ${turn}-${step} ' + i)"`
      })
    case 2:
      return call('search_files', { pattern: `value${n}` })
    case 3:
      return call('show_images', { images: [{ path: `shot${n % SHOTS}.png` }] })
    case 4:
      return call('write_file', { path: `notes/turn${turn}-step${step}.md`, content: `# Notes ${n}\n${'Some notes about the work. '.repeat(800)}` })
    default:
      if (opts.subagentEvery > 0 && turn % opts.subagentEvery === 0 && step === 5) {
        return call('dispatch_agent', {
          description: 'look around',
          prompt: `${SUBAGENT_PROMPT} ${turn}: find where value${n} is defined and summarize the file.`
        })
      }
      return call('read_file', { path: 'big.ts', offset: ((n * 53) % 30000) + 1, limit: 2000 })
  }
}
