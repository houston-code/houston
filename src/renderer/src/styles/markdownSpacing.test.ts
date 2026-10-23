import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A list item's text is a paragraph (`.md-p`), whose bottom margin spaces paragraphs
// apart. Inside a list that margin is dropped, or every item would sit a paragraph's
// gap from the next. A task item wraps its text one level deeper, in
// `.md-task__body`, so it needs the reset too: without it a task list rendered about
// half again as loose as the bullets around it.

const css = readFileSync(join(__dirname, 'global.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector list names `selector`. */
function ruleFor(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim())
    if (selectors.includes(selector)) return m[2]
  }
  throw new Error(`no rule for ${selector}`)
}

describe('markdown list spacing', () => {
  it.each(['.md-list li > .md-p', '.md-task__body > .md-p'])('%s drops the paragraph margin', (selector) => {
    expect(ruleFor(selector)).toMatch(/margin:\s*0;/)
  })
})
