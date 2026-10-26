import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local SSE server that answers like a provider whose network misbehaves, for driving
 * the real SDK clients and adapters over a real socket. Each request takes the next
 * behavior in `script` (the last one repeats): `ok` streams a complete reply, `reset`
 * streams part of one and then destroys the socket (what a dropped connection looks
 * like to fetch), `stall` streams part of one and then goes silent with the socket open
 * (the half-open connection a network switch leaves behind).
 */
export type Hiccup = 'ok' | 'reset' | 'stall'

export interface FlakySseServer {
  /** Base URL: hand it to the Anthropic SDK as is, or with `/v1` to the OpenAI SDK. */
  url: string
  /** Requests answered so far. */
  requests(): number
  close(): Promise<void>
}

const sse = (event: string | undefined, data: unknown): string =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`

/** The Anthropic Messages stream for a one-block text reply, split as `head` + `tail`. */
function anthropicReply(text: string): { head: string; tail: string } {
  const [first, rest] = [text.slice(0, 3), text.slice(3)]
  const head =
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 }
      }
    }) +
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first } })
  const tail =
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: rest } }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) +
    sse('message_stop', { type: 'message_stop' })
  return { head, tail }
}

/** The Chat Completions stream for a text reply, split as `head` + `tail`. */
function chatReply(text: string): { head: string; tail: string } {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    sse(undefined, {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, delta, finish_reason: finish }]
    })
  return {
    head: chunk({ role: 'assistant', content: text.slice(0, 3) }, null),
    tail: chunk({ content: text.slice(3) }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
  }
}

export async function startFlakySseServer(
  api: 'anthropic' | 'chat',
  script: Hiccup[],
  text = 'the whole answer'
): Promise<FlakySseServer> {
  let n = 0
  const server = createServer((req, res) => {
    const behavior = script[Math.min(n, script.length - 1)]
    n++
    req.resume()
    req.on('end', () => {
      const { head, tail } = api === 'anthropic' ? anthropicReply(text) : chatReply(text)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(head)
      if (behavior === 'ok') res.end(tail)
      else if (behavior === 'reset') setTimeout(() => res.socket?.destroy(), 20)
      // 'stall': leave the socket open and say nothing more.
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => n,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
