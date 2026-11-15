import { describe, it, expect } from 'vitest'
import { ISSUES_URL, issueReportUrl } from '@shared/issueReport'
import { makePainter, type TuiDeps, type TuiIo } from './tui'
import { parseFeedbackChoice, runFeedbackCommand, type IssueReportHost } from './tui-feedback'
import type { PickerOutcome, PickerSpec } from './tui-picker'

const BODY = '### What happened?\n\n\n### Environment\n\n- Houston 1.2.3\n- Platform: darwin arm64'

function harness(opts: {
  answers?: Array<string | null>
  pick?: PickerOutcome
  host?: Partial<IssueReportHost> | null
}) {
  const out: string[] = []
  const opened: string[] = []
  const specs: PickerSpec[] = []
  const answers = [...(opts.answers ?? [])]
  const io = {
    out: (s: string) => out.push(s),
    readLine: async () => (answers.length ? answers.shift()! : null),
    ...(opts.pick
      ? {
          select: async (spec: PickerSpec) => {
            specs.push(spec)
            return opts.pick!
          }
        }
      : {})
  } as unknown as TuiIo
  const host: IssueReportHost = {
    body: () => BODY,
    url: (b) => (b === null ? ISSUES_URL : issueReportUrl(ISSUES_URL, b)),
    open: (u) => {
      opened.push(u)
      return true
    },
    ...(opts.host ?? {})
  }
  const deps = { io, ...(opts.host === null ? {} : { issueReport: host }) } as unknown as TuiDeps
  return { deps, out, opened, specs, text: () => out.join('') }
}

const plain = makePainter(false)

describe('parseFeedbackChoice', () => {
  it('reads open, print, and anything else as cancel', () => {
    expect(parseFeedbackChoice('o')).toBe('open')
    expect(parseFeedbackChoice(' Open ')).toBe('open')
    expect(parseFeedbackChoice('p')).toBe('print')
    expect(parseFeedbackChoice('link')).toBe('print')
    expect(parseFeedbackChoice('')).toBe('cancel')
    expect(parseFeedbackChoice(null)).toBe('cancel')
    expect(parseFeedbackChoice('yes please')).toBe('cancel')
  })
})

describe('runFeedbackCommand', () => {
  it('shows exactly what the report holds before anything opens, then opens it', async () => {
    const h = harness({ pick: { kind: 'commit', value: 'open' } })
    await runFeedbackCommand(h.deps, plain)
    const text = h.text()
    expect(text).toContain('It includes no logs, file')
    expect(text).toContain('  - Houston 1.2.3')
    expect(text).toContain('/export it')
    expect(h.specs[0]?.options.map((o) => o.value)).toEqual(['open', 'print', 'cancel'])
    expect(h.opened).toEqual([issueReportUrl(ISSUES_URL, BODY)])
    expect(text).toContain('opened the new-issue page')
    // The consent text came out before the browser was asked to open.
    expect(h.out.findIndex((s) => s.includes('Houston 1.2.3'))).toBeLessThan(h.out.findIndex((s) => s.includes('opened')))
  })

  it('prints the link instead when asked, and opens nothing', async () => {
    const h = harness({ pick: { kind: 'commit', value: 'print' } })
    await runFeedbackCommand(h.deps, plain)
    expect(h.opened).toEqual([])
    expect(h.text()).toContain(`${ISSUES_URL}?body=`)
  })

  it('cancel (or Esc) opens nothing and prints no link', async () => {
    for (const pick of [{ kind: 'commit', value: 'cancel' }, { kind: 'cancel' }] as PickerOutcome[]) {
      const h = harness({ pick })
      await runFeedbackCommand(h.deps, plain)
      expect(h.opened).toEqual([])
      expect(h.text()).not.toContain('?body=')
      expect(h.text()).toContain('nothing opened')
    }
  })

  it('takes a typed answer with no picker, and from the numbered list', async () => {
    const typed = harness({ answers: ['p'] })
    await runFeedbackCommand(typed.deps, plain)
    expect(typed.text()).toContain('?body=')
    const numbered = harness({ pick: { kind: 'type', text: 'o' } })
    await runFeedbackCommand(numbered.deps, plain)
    expect(numbered.opened).toHaveLength(1)
  })

  it('prints the link when no browser opens', async () => {
    const h = harness({ pick: { kind: 'commit', value: 'open' }, host: { open: () => false } })
    await runFeedbackCommand(h.deps, plain)
    expect(h.text()).toContain("couldn't open a browser")
    expect(h.text()).toContain('?body=')
  })

  it('offers a blank issue when the diagnostics fail', async () => {
    const h = harness({
      pick: { kind: 'commit', value: 'print' },
      host: {
        body: () => {
          throw new Error('boom')
        }
      }
    })
    await runFeedbackCommand(h.deps, plain)
    expect(h.text()).toContain("couldn't gather the diagnostics")
    expect(h.text()).toContain(`${ISSUES_URL}\n`)
  })

  it('never lets the report put escape sequences on the terminal', async () => {
    const h = harness({ pick: { kind: 'cancel' }, host: { body: () => 'x\u001b]0;pwn\u0007 \u001b[2J y' } })
    await runFeedbackCommand(h.deps, plain)
    expect(h.text()).not.toContain('\u001b')
    expect(h.text()).not.toContain('\u0007')
  })

  it('says so when the host has no issue report', async () => {
    const h = harness({ host: null })
    await runFeedbackCommand(h.deps, plain)
    expect(h.text()).toContain('unavailable')
  })
})
