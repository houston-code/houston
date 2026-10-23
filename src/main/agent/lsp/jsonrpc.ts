/**
 * JSON-RPC 2.0 over a byte stream with LSP's `Content-Length` framing: each message is
 * a header block (`Content-Length: N\r\n`, optionally `Content-Type`, then a blank
 * line) followed by exactly N bytes of UTF-8 JSON. Pure stream plumbing, no process
 * handling, so the framing and request bookkeeping are unit-testable over an in-memory
 * pair of streams.
 */
import type { Readable, Writable } from 'node:stream'

/** Largest single message accepted from a server. A bigger header is treated as a broken stream. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Encode one message with its `Content-Length` header. */
export function encodeMessage(msg: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/**
 * Incremental decoder: feed it chunks as they arrive, get whole messages out. Chunks
 * may split anywhere, including inside the header or a multi-byte character, because
 * the body is measured in bytes and decoded only once complete.
 */
export class MessageDecoder {
  private buf: Buffer = Buffer.alloc(0)

  /** Append a chunk and return every message it completed. Throws on a malformed frame. */
  push(chunk: Buffer): JsonRpcMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: JsonRpcMessage[] = []
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (this.buf.length > 8192) throw new Error('LSP header block too long')
        return out
      }
      const header = this.buf.subarray(0, headerEnd).toString('ascii')
      const m = /^content-length:\s*(\d+)\s*$/im.exec(header)
      if (!m) throw new Error('LSP message without a Content-Length header')
      const len = Number(m[1])
      if (len > MAX_MESSAGE_BYTES) throw new Error(`LSP message too large (${len} bytes)`)
      const start = headerEnd + 4
      if (this.buf.length < start + len) return out
      const body = this.buf.subarray(start, start + len).toString('utf8')
      this.buf = this.buf.subarray(start + len)
      out.push(JSON.parse(body) as JsonRpcMessage)
    }
  }
}

/** A JSON-RPC error a request was answered with. */
export class ResponseError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

/** The request timed out before the server answered. */
export class RequestTimeoutError extends Error {}

/** The connection closed (the server exited or the stream broke) with the request still open. */
export class ConnectionClosedError extends Error {}

/** JSON-RPC's "method not found", returned for server requests the client doesn't handle. */
const METHOD_NOT_FOUND = -32601

type RequestHandler = (params: unknown) => unknown
type NotificationHandler = (params: unknown) => void

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  method: string
}

/**
 * Both directions of a JSON-RPC session: outgoing requests (with an id, a timeout, and
 * a promise for the answer), outgoing notifications, and dispatch of what the server
 * sends (responses, notifications, and its own requests, which get an answer even
 * when no handler is registered so the server never waits on us).
 */
export class JsonRpcConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly notificationHandlers = new Map<string, NotificationHandler>()
  private readonly decoder = new MessageDecoder()
  private closed = false
  private closeListeners: ((reason: string) => void)[] = []

  constructor(
    input: Readable,
    private readonly output: Writable
  ) {
    input.on('data', (chunk: Buffer) => this.onData(chunk))
    input.on('end', () => this.close('stream ended'))
    input.on('error', (e) => this.close(`stream error: ${e.message}`))
    output.on('error', (e) => this.close(`stream error: ${e.message}`))
  }

  get isClosed(): boolean {
    return this.closed
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener)
  }

  /** Send a request and resolve with its result; rejects on an error answer, a timeout, or close. */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new ConnectionClosedError(`connection closed before ${method}`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              this.pending.delete(id)
              // Tell the server it can stop; harmless if it already finished.
              this.notify('$/cancelRequest', { id })
              reject(new RequestTimeoutError(`${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          : null
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Fail every open request and stop dispatching. Idempotent. */
  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new ConnectionClosedError(`${p.method} failed: ${reason}`))
      this.pending.delete(id)
    }
    for (const l of this.closeListeners) l(reason)
    this.closeListeners = []
  }

  private write(msg: JsonRpcMessage): void {
    try {
      this.output.write(encodeMessage(msg))
    } catch (e) {
      this.close(`write failed: ${(e as Error).message}`)
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    let messages: JsonRpcMessage[]
    try {
      messages = this.decoder.push(chunk)
    } catch (e) {
      // A desynchronized stream can't be recovered: every later byte is misframed.
      this.close(`protocol error: ${(e as Error).message}`)
      return
    }
    for (const msg of messages) this.dispatch(msg)
  }

  private dispatch(msg: JsonRpcMessage): void {
    // A body that parses to something other than an object (`null`, a number, a batch
    // array, which LSP never uses) is no message: reading its fields would throw out of
    // the stream's data handler, which takes down the whole process.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return
    if (msg.method !== undefined) {
      if (msg.id !== undefined && msg.id !== null) {
        void this.answer(msg.id, msg.method, msg.params)
      } else {
        try {
          this.notificationHandlers.get(msg.method)?.(msg.params)
        } catch {
          // A handler bug must not take the connection down.
        }
      }
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return // answered after its timeout: already rejected
    this.pending.delete(msg.id)
    if (p.timer) clearTimeout(p.timer)
    if (msg.error) p.reject(new ResponseError(msg.error.code, msg.error.message))
    else p.resolve(msg.result ?? null)
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method)
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Unhandled method ${method}` } })
      return
    }
    try {
      const result = await handler(params)
      this.write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (e) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } })
    }
  }
}
