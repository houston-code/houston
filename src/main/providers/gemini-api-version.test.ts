import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeminiProvider, GEMINI_API_VERSION, listGeminiModels } from './gemini'

/**
 * The Gemini SDK picks the API version from code, then GOOGLE_GENAI_API_VERSION, then its
 * own default (`v1` since SDK 3). Houston pins `v1beta` in code. These drive the REAL SDK
 * against a local server and read the request path, so an upgrade that moves the endpoint,
 * or an environment variable on the user's machine, fails here.
 */

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
  vi.unstubAllEnvs()
})

/** A server that records each request path and answers 200 with the given body. */
async function recordPaths(contentType: string, body: string): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url ?? '')
    req.resume()
    res.writeHead(200, { 'content-type': contentType })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, paths }
}

describe('Gemini API version', () => {
  it('is v1beta', () => {
    expect(GEMINI_API_VERSION).toBe('v1beta')
  })

  it('chat calls the pinned version, even with GOOGLE_GENAI_API_VERSION set', async () => {
    const chunk = { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }
    const { url, paths } = await recordPaths('text/event-stream', `data: ${JSON.stringify(chunk)}\n\n`)
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', url)
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', 'v1')
    const gen = createGeminiProvider('k').streamChat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      signal: AbortSignal.timeout(5_000)
    })
    while (!(await gen.next()).done) {
      /* drain */
    }
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(p).toMatch(/^\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent/)
  })

  it('model listing calls the pinned version, even with GOOGLE_GENAI_API_VERSION set', async () => {
    const { url, paths } = await recordPaths('application/json', JSON.stringify({ models: [] }))
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', url)
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', 'v1')
    await listGeminiModels('k')
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(p).toMatch(/^\/v1beta\/models/)
  })
})
