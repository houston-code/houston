import { describe, it, expect } from 'vitest'
import type { Formatter } from './agent/format'
import { formatterStatuses, getIntegrations } from './integrations'

const REGISTRY: Record<string, Formatter[]> = {
  ts: [{ bin: 'prettier', args: (p) => [p] }],
  tsx: [{ bin: 'prettier', args: (p) => [p] }],
  go: [{ bin: 'gofmt', args: (p) => ['-w', p] }],
  py: [
    { bin: 'ruff', args: (p) => ['format', p] },
    { bin: 'black', args: (p) => [p] }
  ]
}

describe('formatterStatuses', () => {
  it('dedupes binaries and collects the extensions each covers, sorted', () => {
    const present = new Set(['prettier', 'gofmt'])
    const statuses = formatterStatuses(REGISTRY, (b) => present.has(b))
    expect(statuses.map((s) => s.bin)).toEqual(['black', 'gofmt', 'prettier', 'ruff']) // sorted
    const prettier = statuses.find((s) => s.bin === 'prettier')!
    expect(prettier.languages).toEqual(['ts', 'tsx'])
    expect(prettier.installed).toBe(true)
  })

  it('reports each binary installed state independently', () => {
    const statuses = formatterStatuses(REGISTRY, (b) => b === 'ruff')
    expect(statuses.find((s) => s.bin === 'ruff')!.installed).toBe(true)
    expect(statuses.find((s) => s.bin === 'black')!.installed).toBe(false)
    expect(statuses.find((s) => s.bin === 'gofmt')!.installed).toBe(false)
  })
})

describe('getIntegrations', () => {
  it('reports gh installed + authenticated when present and auth succeeds', async () => {
    const info = await getIntegrations({
      resolveGh: () => '/usr/bin/gh',
      ghAuthOk: async () => true,
      hasBin: () => false,
      formatters: REGISTRY
    })
    expect(info.gh).toEqual({ installed: true, authenticated: true })
  })

  it('reports installed but not authenticated when auth fails', async () => {
    const info = await getIntegrations({
      resolveGh: () => '/usr/bin/gh',
      ghAuthOk: async () => false,
      hasBin: () => false,
      formatters: REGISTRY
    })
    expect(info.gh).toEqual({ installed: true, authenticated: false })
  })

  it('does not probe auth when gh is absent (authenticated stays false)', async () => {
    let authProbed = false
    const info = await getIntegrations({
      resolveGh: () => null,
      ghAuthOk: async () => {
        authProbed = true
        return true
      },
      hasBin: () => false,
      formatters: REGISTRY
    })
    expect(info.gh).toEqual({ installed: false, authenticated: false })
    expect(authProbed).toBe(false)
  })

  it('includes the formatter statuses', async () => {
    const info = await getIntegrations({
      resolveGh: () => null,
      hasBin: (b) => b === 'prettier',
      formatters: REGISTRY
    })
    expect(info.formatters.find((f) => f.bin === 'prettier')!.installed).toBe(true)
    expect(info.formatters.find((f) => f.bin === 'gofmt')!.installed).toBe(false)
  })
})
