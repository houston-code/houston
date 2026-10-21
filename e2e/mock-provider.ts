import http from 'node:http'

/** One scripted assistant reply: either plain text or a single tool call. */
export type MockReply = { text: string } | { tool: string; args: Record<string, unknown> }

interface ChatMessage {
  role: string
  content?: unknown
  tool_call_id?: string
}

export interface MockProvider {
  /** The OpenAI-compatible base URL to configure the app with (ends in /v1). */
  baseUrl: string
  /** The tool results the app sent back, in order: the output of each tool it ran. */
  toolResults: string[]
  /** How many chat-completion requests the app made. */
  requests: number
  close(): Promise<void>
}

/** Flatten a chat message's content (a string, or an array of text parts) to text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('')
  }
  return ''
}

/**
 * A loopback stand-in for an OpenAI-compatible model server, so the e2e suite can drive
 * a real agent turn through the packaged app without an API key or network. It speaks
 * just enough of the Chat Completions API: `GET /v1/models` and streaming
 * `POST /v1/chat/completions`.
 *
 * The reply is chosen by how many tool results the request already carries: with none
 * it plays `script[0]`, after the first tool ran `script[1]`, and so on. That keys the
 * script to the conversation's own progress, so a retried request replays the same step
 * rather than skipping ahead. Past the end of the script it answers with the last entry.
 */
export function startMockProvider(model: string, script: MockReply[]): Promise<MockProvider> {
  const state: MockProvider = {
    baseUrl: '',
    toolResults: [],
    requests: 0,
    close: async () => {}
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'e2e' }] }))
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
      state.requests++
      const messages = (JSON.parse(body) as { messages: ChatMessage[] }).messages
      const results = messages.filter((m) => m.role === 'tool').map((m) => contentText(m.content))
      // Record each tool result the first time it shows up.
      for (let i = state.toolResults.length; i < results.length; i++) state.toolResults.push(results[i])
      const step = script[Math.min(results.length, script.length - 1)]
      streamReply(res, model, step, results.length)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      state.baseUrl = `http://127.0.0.1:${port}/v1`
      state.close = () =>
        new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        })
      resolve(state)
    })
  })
}

/** Write one scripted reply as a Chat Completions SSE stream. */
function streamReply(res: http.ServerResponse, model: string, step: MockReply, n: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const id = `chatcmpl-e2e-${n}`
  const chunk = (delta: object, finish: string | null = null): void => {
    const payload = { id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] }
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  chunk({ role: 'assistant', content: '' })
  if ('text' in step) {
    chunk({ content: step.text })
    chunk({}, 'stop')
  } else {
    chunk({
      tool_calls: [
        { index: 0, id: `call_e2e_${n}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }
      ]
    })
    chunk({}, 'tool_calls')
  }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [], usage })}\n\n`)
  res.end('data: [DONE]\n\n')
}
