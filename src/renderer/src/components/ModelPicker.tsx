import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AppSettings, ModelOption, ProviderConfig, SelectedModel } from '@shared/types'
import {
  formatTokens,
  resolveCapabilities,
  resolveContextWindow,
  resolvePricing,
  resolveToolSupport
} from '@shared/usage'
import { modelDisplayName, sortedModels } from '@shared/models'
import { Popover } from './Popover'

/** Shown when the selected model doesn't advertise tool-calling support. */
const TOOL_WARNING =
  "This model doesn't support tool calling, which this agent requires. " +
  'Pick a tool-capable model (e.g. qwen2.5-coder, llama3.1, mistral-nemo).'

/** A model added by an update reads as "New" for this long after it arrived. */
const NEW_AFTER_ADDED_DAYS = 30
/** A model the host lists as released within this window reads as "New". */
const NEW_AFTER_RELEASE_DAYS = 45
const DAY_MS = 86_400_000

/** "Anthropic (Claude)" or "OpenAI (GPT) (no key)" when a required key is missing. */
function groupLabel(p: ProviderConfig): string {
  return `${p.label}${p.requiresKey && !p.hasKey ? ' (no key)' : ''}`
}

/** A provider whose models can actually be called right now (its key is set, or it needs none). */
function isUsable(p: ProviderConfig): boolean {
  return !p.requiresKey || p.hasKey
}

/**
 * A model's display name: an explicit per-model `label` override if one is set (only
 * a custom endpoint would), otherwise derived from the id in the provider's naming
 * convention so seeded and live-fetched models read identically.
 */
function modelName(kind: ProviderConfig['kind'], m: ModelOption): string {
  return m.label ?? modelDisplayName(kind, m.id)
}

/** The context-window suffix shown after a model name, e.g. "400k" — empty when unknown. */
function windowLabel(m: ModelOption): string {
  const win = resolveContextWindow(m.id, m.caps)
  return win ? formatTokens(win) : ''
}

/** A per-million-token price, compact: `$4`, `$2.50`, `$0.10`. */
function usd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`
}

/** Input / output price per million tokens, or null when no price is known. */
function priceOf(m: ModelOption): { short: string; spoken: string } | null {
  const p = resolvePricing(m.id, m.caps)
  if (!p) return null
  const base = `${usd(p.input)} input, ${usd(p.output)} output per million tokens`
  const long = p.longContext
  return {
    // A trailing "+" marks a price that rises for long prompts; the tooltip and the spoken
    // name give the higher rate.
    short: `${usd(p.input)}/${usd(p.output)}${long ? '+' : ''}`,
    spoken: long
      ? `${base}, ${usd(long.input)} input, ${usd(long.output)} output above ${formatTokens(long.above)} tokens`
      : base
  }
}

function daysSince(date: string | undefined, now: Date): number | null {
  const t = date ? Date.parse(date) : NaN
  return Number.isFinite(t) ? (now.getTime() - t) / DAY_MS : null
}

/** Whether the model is new: added by a recent update, or released recently per its host. */
function isNew(m: ModelOption, now: Date): boolean {
  const added = daysSince(m.addedAt, now)
  if (added !== null && added >= 0 && added <= NEW_AFTER_ADDED_DAYS) return true
  const released = daysSince(m.caps?.releasedAt, now)
  return released !== null && released >= 0 && released <= NEW_AFTER_RELEASE_DAYS
}

interface CapChip {
  key: string
  glyph: string
  title: string
  /** The capability as read aloud in the option's accessible name. */
  spoken: string
}

/**
 * Capability badges for a model option: tool calling, vision, reasoning. Tools come from
 * the host's listing, else from the id for the hosted families that all call tools; an
 * open model the id can't vouch for shows no badge. Vision/reasoning use the resolver, so
 * curated families light up even without listed metadata.
 */
function capChips(m: ModelOption): CapChip[] {
  const caps = resolveCapabilities(m.id, m.caps)
  const chips: CapChip[] = []
  if (resolveToolSupport(m.caps, m.id) === true) {
    chips.push({ key: 'tools', glyph: 'T', title: 'Supports tool calling', spoken: 'tools' })
  }
  if (caps.vision) chips.push({ key: 'vision', glyph: 'V', title: 'Accepts images (vision)', spoken: 'vision' })
  if (caps.reasoning) {
    chips.push({ key: 'reasoning', glyph: 'R', title: 'Has a reasoning mode', spoken: 'reasoning' })
  }
  return chips
}

/** Whether every whitespace-separated term of the query appears in the model's name, id, or provider. */
function matches(query: string, haystack: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const h = haystack.toLowerCase()
  return terms.every((t) => h.includes(t))
}

interface FlatOption {
  providerId: string
  modelId: string
}

/**
 * Model selector: a trigger plus a popover listbox with a search field. It's a popover
 * rather than a native <select> so it can open upward from the bottom-docked control bar,
 * group by provider, and annotate each model (capabilities, price, context window, "New").
 *
 * Providers that can be called right now are listed first; ones missing a key follow, and
 * ones with no models collapse into a single line. Typing filters across every provider.
 * Keyboard: focus lands in the search field; ↑/↓ move the active option, Enter selects,
 * Escape closes. Each option's accessible name spells out what the badges show.
 */
export function ModelPicker({
  settings,
  selected,
  onSelect,
  now
}: {
  settings: AppSettings
  selected: SelectedModel | null
  onSelect: (sel: SelectedModel) => void
  /** The current time, for the "New" mark. Injectable for tests. */
  now?: Date
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const optId = (idx: number): string => `${listId}-opt-${idx}`
  const today = now ?? new Date()

  // Each provider's models in display order: usable providers first, then the ones
  // missing a key. Providers with no models are listed separately on one line.
  const groups = useMemo(() => {
    const all = settings.providers.map((p) => ({ provider: p, models: sortedModels(p.kind, p.models) }))
    const stocked = all.filter((g) => g.models.length > 0)
    return {
      stocked: [...stocked.filter((g) => isUsable(g.provider)), ...stocked.filter((g) => !isUsable(g.provider))],
      empty: all.filter((g) => g.models.length === 0).map((g) => g.provider)
    }
  }, [settings.providers])

  const visible = useMemo(() => {
    if (!query.trim()) return groups.stocked
    return groups.stocked
      .map((g) => ({
        ...g,
        models: g.models.filter((m) =>
          matches(query, `${modelName(g.provider.kind, m)} ${m.id} ${g.provider.label}`)
        )
      }))
      .filter((g) => g.models.length > 0)
  }, [groups, query])

  const flat = useMemo<FlatOption[]>(
    () => visible.flatMap(({ provider, models }) => models.map((m) => ({ providerId: provider.id, modelId: m.id }))),
    [visible]
  )

  const selectedKey = selected ? `${selected.providerId}::${selected.model}` : ''
  const selectedProvider = settings.providers.find((p) => p.id === selected?.providerId)
  const selectedModel = selectedProvider?.models.find((m) => m.id === selected?.model)

  // Warn at selection time when the chosen model can't call tools (this agent
  // requires them) rather than letting the first turn 400. Two sources, in order:
  //   1. Host-listed capability (any provider) — a definitive `false` warns at once.
  //   2. For a local (Ollama) server that lists nothing, a live preflight. Only a
  //      definitive `false` warns; `null` (server down, model not pulled, old
  //      version) is "unknown" and stays silent. Re-checks when the selection changes.
  const [lacksTools, setLacksTools] = useState(false)
  const providerId = selected?.providerId
  const model = selected?.model
  const providerKind = selectedProvider?.kind
  const listedTools = resolveToolSupport(selectedModel?.caps)
  useEffect(() => {
    setLacksTools(false)
    if (listedTools === false) {
      setLacksTools(true)
      return
    }
    if (listedTools === true) return // host says it's tool-capable; no need to probe
    if (!providerId || !model || providerKind !== 'openai-compatible') return
    const check = window.api?.ollamaSupportsTools
    if (!check) return
    let cancelled = false
    void check(providerId, model)
      .then((supported) => {
        if (!cancelled && supported === false) setLacksTools(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [providerId, model, providerKind, listedTools])
  // Only label the trigger when the selection resolves to a model that still exists.
  // A selection pointing at a removed model/provider falls through to the placeholder
  // (the store reconciles these away on save/load, but stay defensive so a stale id is
  // never shown as if it were pickable).
  const triggerLabel =
    selected && selectedProvider && selectedModel
      ? `${modelName(selectedProvider.kind, selectedModel)}${
          windowLabel(selectedModel) ? ` · ${windowLabel(selectedModel)}` : ''
        }`
      : 'Select a model…'

  // Keep the active option scrolled into view while arrowing through a long list.
  const reveal = (idx: number): void => {
    setActive(idx)
    requestAnimationFrame(() => {
      document.getElementById(optId(idx))?.scrollIntoView?.({ block: 'nearest' })
    })
  }

  const openMenu = (initialQuery = ''): void => {
    setQuery(initialQuery)
    if (initialQuery) {
      setActive(0)
    } else {
      const idx = groups.stocked
        .flatMap(({ provider, models }) => models.map((m) => `${provider.id}::${m.id}`))
        .indexOf(selectedKey)
      setActive(idx >= 0 ? idx : 0)
    }
    setOpen(true)
  }
  const close = (): void => {
    setOpen(false)
    btnRef.current?.focus()
  }
  const choose = (f: FlatOption): void => {
    onSelect({ providerId: f.providerId, model: f.modelId })
    close()
  }

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openMenu()
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Typing on the closed trigger opens the menu already filtered by that character.
      e.preventDefault()
      openMenu(e.key)
    }
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flat.length) reveal(Math.min(flat.length - 1, active + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length) reveal(Math.max(0, active - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flat[active]) choose(flat[active])
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  let idx = -1
  return (
    <>
      <span className="model-control">
        <button
          ref={btnRef}
          type="button"
          className={`control control--select control--model${lacksTools ? ' control--model-warn' : ''}`}
          title={selected ? triggerLabel : 'Select a model'}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-describedby={lacksTools ? 'model-tool-warning' : undefined}
          onClick={() => (open ? close() : openMenu())}
          onKeyDown={onTriggerKeyDown}
        >
          {lacksTools && (
            <span className="control__icon" aria-hidden="true">
              ⚠
            </span>
          )}
          <span className="control__text">{triggerLabel}</span>
        </button>
        {/* Explains the ⚠ on hover/focus; tied to the trigger via aria-describedby so
            screen readers read it when the model button is focused. */}
        {lacksTools && (
          <span id="model-tool-warning" role="tooltip" className="model-warn-tip">
            {TOOL_WARNING}
          </span>
        )}
      </span>

      {open && (
        <Popover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          align="left"
          className="menu model-menu"
          roving={false}
        >
          <input
            type="search"
            className="model-menu__search"
            placeholder="Search models"
            aria-label="Search models"
            aria-controls={listId}
            aria-activedescendant={flat[active] ? optId(active) : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onSearchKeyDown}
          />
          <div id={listId} role="listbox" aria-label="Model" className="model-menu__list">
            {visible.map(({ provider, models }) => (
              <div key={provider.id} role="group" aria-label={groupLabel(provider)}>
                <div className="menu__label">{groupLabel(provider)}</div>
                {models.map((m) => {
                  idx += 1
                  const i = idx
                  const key = `${provider.id}::${m.id}`
                  const isSelected = key === selectedKey
                  const win = windowLabel(m)
                  const chips = capChips(m)
                  const price = priceOf(m)
                  const fresh = isNew(m, today)
                  const name = modelName(provider.kind, m)
                  const spoken = [
                    name,
                    win && `${win} context`,
                    ...chips.map((c) => c.spoken),
                    price?.spoken,
                    fresh && 'new'
                  ]
                    .filter(Boolean)
                    .join(', ')
                  return (
                    <button
                      key={key}
                      id={optId(i)}
                      type="button"
                      tabIndex={-1}
                      role="option"
                      aria-selected={isSelected}
                      aria-label={spoken}
                      className={`model-menu__opt${i === active ? ' model-menu__opt--active' : ''}${
                        isSelected ? ' model-menu__opt--selected' : ''
                      }`}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose({ providerId: provider.id, modelId: m.id })}
                    >
                      <span className="model-menu__check" aria-hidden="true">
                        {isSelected ? '✓' : ''}
                      </span>
                      <span className="model-menu__name">
                        {name}
                        {fresh && (
                          <span className="model-menu__new" aria-hidden="true">
                            New
                          </span>
                        )}
                      </span>
                      <span className="model-menu__meta" aria-hidden="true">
                        {chips.length > 0 && (
                          <span className="model-menu__caps">
                            {chips.map((c) => (
                              <span key={c.key} className="model-cap" title={c.title}>
                                {c.glyph}
                              </span>
                            ))}
                          </span>
                        )}
                        {price && (
                          <span className="model-menu__price" title={`Per million tokens: ${price.spoken}`}>
                            {price.short}
                          </span>
                        )}
                        {win && <span className="model-menu__win">{win}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
            {query.trim() && flat.length === 0 && (
              <div className="model-menu__empty">No models match &ldquo;{query.trim()}&rdquo;</div>
            )}
          </div>
          {!query.trim() && groups.empty.length > 0 && (
            <div className="model-menu__footnote">
              No models yet: {groups.empty.map((p) => p.label).join(', ')}
            </div>
          )}
        </Popover>
      )}
    </>
  )
}
