import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import { previewSchedule, scheduleInputFrom } from './scheduleIpc'

const providers = [{ id: 'anthropic', label: 'Anthropic', models: [{ id: 'm1' }] } as unknown as ProviderConfig]
const realDir = (p: string): string | null => (p === 'proj' ? 'real-proj' : null)
const ok = {
  name: '',
  spec: 'daily at 09:00',
  prompt: 'Check the build\nand report',
  workspace: 'proj',
  providerId: 'anthropic',
  model: 'm1',
  approvalPolicy: 'plan'
}

describe('scheduleInputFrom', () => {
  it('builds the scheduler input, resolving the folder and naming it from the first line', () => {
    expect(scheduleInputFrom(ok, { providers, realDir })).toEqual({
      name: 'Check the build',
      spec: 'daily at 09:00',
      prompt: 'Check the build\nand report',
      workspace: 'real-proj',
      providerId: 'anthropic',
      model: 'm1',
      approvalPolicy: 'plan'
    })
  })

  it('says what is wrong with each missing or unknown field', () => {
    const bad = (over: Record<string, unknown>): unknown => scheduleInputFrom({ ...ok, ...over }, { providers, realDir })
    expect(bad({ prompt: ' ' })).toBe('Write the task each run starts with.')
    expect(bad({ prompt: 'x'.repeat(20_001) })).toMatch(/too long/)
    expect(bad({ spec: '' })).toMatch(/Say when it runs/)
    expect(bad({ workspace: 'missing' })).toBe('Choose a folder that exists.')
    expect(bad({ providerId: 'nope' })).toBe('Choose a configured model.')
    expect(bad({ model: '' })).toBe('Choose a model.')
    expect(bad({ approvalPolicy: 'yolo' })).toBe('Choose an approval mode.')
    expect(scheduleInputFrom(null, { providers, realDir })).toBe('Missing details.')
  })
})

describe('previewSchedule', () => {
  const now = new Date(2026, 6, 15, 12, 0, 0)
  it('normalizes a spec and gives its next run', () => {
    expect(previewSchedule('every 30 minutes', now)).toEqual({ ok: true, spec: 'every 30m', nextRunAt: now.getTime() + 30 * 60 * 1000 })
  })
  it("passes the parser's message through", () => {
    const r = previewSchedule('every 1m', now)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/minimum is 5 minutes/)
    expect(previewSchedule(42, now)).toEqual({ ok: false, error: 'Say when it runs.' })
  })
})
