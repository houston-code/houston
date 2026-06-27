#!/usr/bin/env node
// AI-generated, user-facing CHANGELOG section. Drop-in replacement for
// gen-release-notes.mjs: reads the same merged-PR JSON on stdin (number/title/labels/body),
// takes VERSION from the env, and writes the same Markdown section shape to stdout — so
// release-prepare.yml can swap between the two and prependToChangelog/extractSection keep
// working. The deterministic generator only buckets PR titles; this one reads the PR bodies
// and writes the sharp summary + breaking changes + required steps that CI can't infer.
//
// The output still lands in the human-reviewed release PR, so a person edits it before it
// ships — that review gate is what makes trusting a model for this safe. release-prepare.yml
// falls back to gen-release-notes.mjs when ANTHROPIC_API_KEY is absent or this call fails.
//
// buildPrompt/extractText are pure and unit-tested; the CLI wrapper (which makes the API
// call) runs only when invoked directly.

import Anthropic from '@anthropic-ai/sdk'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const MODEL = 'claude-opus-4-8'

// Houston's repo policy forbids naming competing tools/products anywhere — bake it into the
// instructions so generated notes never do.
export const SYSTEM_PROMPT = `You are writing release notes for Houston, a desktop app, for an audience of end users.

Write notes that are sharp, crisp, and strictly about what changed for the user. Rules:
- Summarize only user-facing impact. Drop purely internal changes (CI, tests, refactors, dependency bumps, docs) entirely.
- Do NOT invent changes. Only describe what the provided pull requests actually did; if a PR's effect is unclear, omit it rather than guess.
- Call out breaking changes and any manual/migration steps the user must take, explicitly.
- Never name competing tools, products, or companies — describe capabilities on their own terms.
- Output raw Markdown only — no code fences, no preamble, no commentary outside the notes.`

// Build the user prompt: the exact heading to use, plus the merged PRs to summarize.
export function buildPrompt({ version, date, prs }) {
  const list = (prs || [])
    .map((pr) => {
      const labels = (pr.labels || [])
        .map((l) => (typeof l === 'string' ? l : l.name))
        .filter(Boolean)
        .join(', ')
      const body = (pr.body || '').trim().slice(0, 1500)
      return [
        `### PR #${pr.number}: ${pr.title}`,
        labels ? `labels: ${labels}` : null,
        body ? `body:\n${body}` : '(no description)'
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')

  return `Write the CHANGELOG section for release v${version}.

Start with exactly this heading line and nothing before it:
## v${version} — ${date}

Then a 2–3 sentence plain-English summary of the release. Then, only the sections that apply, in this order, as \`###\` headings: "Breaking changes", "Required steps", "Added", "Fixed", "Changed". Use \`- \` bullets and cite the PR number like \`(#123)\`. Omit a section if it has no entries, except always include "Breaking changes" (write a single bullet "- None." when there are none).

Merged pull requests in this release:

${list || '(no pull requests)'}`
}

// Pull the text out of the response content blocks (ignoring thinking blocks) and strip a
// wrapping code fence if the model added one despite the instruction.
export function extractText(content) {
  let text = (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text)
  if (fence) text = fence[1].trim()
  return text
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const version = process.env.VERSION
  if (!version) {
    console.error('ai-release-notes: VERSION env is required')
    process.exit(1)
  }
  const date = process.env.RELEASE_DATE || new Date().toISOString().slice(0, 10)

  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  const prs = raw ? JSON.parse(raw) : []

  // new Anthropic() reads ANTHROPIC_API_KEY from the env.
  const client = new Anthropic()
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt({ version, date, prs }) }]
  })

  const text = extractText(message.content)
  if (!text) {
    console.error('ai-release-notes: model returned no text')
    process.exit(1)
  }
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}
