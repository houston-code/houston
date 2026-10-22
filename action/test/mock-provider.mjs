#!/usr/bin/env node
// A scripted stand-in for an OpenAI-compatible chat completions endpoint, so the action
// can be exercised end to end in CI with no model API key and no network.
//
//   node mock-provider.mjs --port 0 --script steps.json --log requests.jsonl --ready port.txt
//
// The script is a JSON array of scenarios, {"match": "<text>", "steps": [...]}. A request
// plays the first scenario whose `match` appears in its first user message (an empty match
// takes anything). Within it, each request is answered with the step whose index is the
// number of tool results already in the conversation, so step 0 answers the first round,
// step 1 the round after the first tool call, and so on; past the end the last step
// repeats. A step is either {"text": "..."} or {"tool": "<name>", "args": {...}}.
// Every request body is appended to the log as one JSON line, for assertions.
import { createServer } from 'node:http'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const scenarios = JSON.parse(readFileSync(arg('script'), 'utf8'))
const logPath = arg('log')
const readyPath = arg('ready')
const MODEL = 'mock-model'

/** Message content as plain text, whether a string or an array of parts. */
function textOf(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : ''
}

/** The step that answers a conversation: its scenario, then how many tool results it holds. */
function stepFor(messages) {
  const first = textOf(messages.find((m) => m.role === 'user')?.content)
  const scenario = scenarios.find((s) => first.includes(s.match ?? '')) ?? { steps: [{ text: 'no scenario matched' }] }
  const done = messages.filter((m) => m.role === 'tool').length
  return scenario.steps[Math.min(done, scenario.steps.length - 1)]
}

function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }]
  }
}

function respond(res, body) {
  const step = stepFor(body.messages ?? [])
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sse(chunk({ role: 'assistant', content: '' }))
  if (step.tool) {
    sse(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) }
          }
        ]
      })
    )
    sse(chunk({}, 'tool_calls'))
  } else {
    sse(chunk({ content: step.text ?? '' }))
    sse(chunk({}, 'stop'))
  }
  sse({ ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'mock' }] }))
    return
  }
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      if (logPath) appendFileSync(logPath, `${JSON.stringify(body)}\n`)
      respond(res, body)
    })
    return
  }
  res.writeHead(404).end()
})

server.listen(Number(arg('port', '0')), '127.0.0.1', () => {
  const { port } = server.address()
  if (readyPath) writeFileSync(readyPath, String(port))
  process.stdout.write(`mock provider listening on 127.0.0.1:${port}\n`)
})
