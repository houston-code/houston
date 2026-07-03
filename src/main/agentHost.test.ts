import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, PermissionRule, ProviderConfig } from '@shared/types'
import {
  addPermissionRule,
  configureAgentHost,
  getKey,
  getProvider,
  getSecretHeaders,
  getSettings,
  hasStoredKey,
  resetAgentHost,
  type AgentHost
} from './agentHost'

/**
 * The engine reads settings/secrets through this accessor instead of importing the
 * Electron-backed store/secrets, so two things must hold: (1) accessing before the
 * shell wires a host fails loudly rather than silently returning undefined, and
 * (2) once wired, every accessor delegates to the injected implementation.
 */

afterEach(() => resetAgentHost())

describe('agentHost', () => {
  it('throws a clear error when used before a host is configured', () => {
    resetAgentHost()
    expect(() => getSettings()).toThrow(/not configured/)
    expect(() => getProvider('anthropic')).toThrow(/not configured/)
    expect(() => getKey('anthropic')).toThrow(/not configured/)
    expect(() => hasStoredKey('anthropic')).toThrow(/not configured/)
    expect(() => getSecretHeaders('provider:anthropic')).toThrow(/not configured/)
    expect(() => addPermissionRule({} as PermissionRule)).toThrow(/not configured/)
  })

  it('delegates every accessor to the configured host', () => {
    const provider = { id: 'anthropic' } as ProviderConfig
    const settings = { providers: [provider] } as unknown as AppSettings
    const rule: PermissionRule = { action: 'allow', tool: 'read_file', match: '*' } as PermissionRule
    const host: AgentHost = {
      getProvider: vi.fn(() => provider),
      getSettings: vi.fn(() => settings),
      addPermissionRule: vi.fn(() => settings),
      getKey: vi.fn(() => 'sk-test'),
      hasStoredKey: vi.fn(() => true),
      getSecretHeaders: vi.fn(() => ({ Authorization: 'Bearer t' }))
    }
    configureAgentHost(host)

    expect(getProvider('anthropic')).toBe(provider)
    expect(host.getProvider).toHaveBeenCalledWith('anthropic')
    expect(getSettings()).toBe(settings)
    expect(addPermissionRule(rule)).toBe(settings)
    expect(host.addPermissionRule).toHaveBeenCalledWith(rule)
    expect(getKey('anthropic')).toBe('sk-test')
    expect(host.getKey).toHaveBeenCalledWith('anthropic')
    expect(hasStoredKey('anthropic')).toBe(true)
    expect(getSecretHeaders('provider:anthropic')).toEqual({ Authorization: 'Bearer t' })
    expect(host.getSecretHeaders).toHaveBeenCalledWith('provider:anthropic')
  })

  it('lets a later configure call replace the wired host', () => {
    configureAgentHost({
      getProvider: () => undefined,
      getSettings: () => ({}) as AppSettings,
      addPermissionRule: () => ({}) as AppSettings,
      getKey: () => 'first',
      hasStoredKey: () => false,
      getSecretHeaders: () => ({})
    })
    expect(getKey('x')).toBe('first')

    configureAgentHost({
      getProvider: () => undefined,
      getSettings: () => ({}) as AppSettings,
      addPermissionRule: () => ({}) as AppSettings,
      getKey: () => 'second',
      hasStoredKey: () => true,
      getSecretHeaders: () => ({})
    })
    expect(getKey('x')).toBe('second')
    expect(hasStoredKey('x')).toBe(true)
  })
})
