import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AppSettings, ModelOption, ProviderConfig, SelectedModel } from '@shared/types'
import {
  formatTokens,
  resolveCapabilities,
  resolveContextWindow,
  resolveToolSupport
} from '@shared/usage'
import { sortedModels } from '@shared/models'
import { Popover } from './Popover'

/** Shown when the selected model doesn't advertise tool-calling support. */
const TOOL_WARNING =
  "This model doesn't support tool calling, which this agent requires. " +
  'Pick a tool-capable model (e.g. qwen2.5-coder, llama3.1, mistral-nemo).'

/** "Anthropic (Claude)" or "OpenAI (GPT) (no key)" when a required key is missing. */
function groupLabel(p: ProviderConfig): string {
  return `${p.label}${p.requiresKey && !p.hasKey ? ' (no key)' : ''}`
}

/** The context-window suffix shown after a model name, e.g. "400k" — empty when unknown. */
function windowLabel(m: ModelOption): string {
  const win = resolveContextWindow(m.id, m.caps)
  return win ? formatTokens(win) : ''
}

interface CapChip {
  key: string
  glyph: string
  title: string
}

/**
 * Capability badges for a model option: tool calling, vision, reasoning. Tools show
 * only when a host explicitly reports support (there's no reliable name heuristic);
 * vision/reasoning use the resolver, so curated families light up even without
 * listed metadata.
 */
function capChips(m: ModelOption): CapChip[] {
  const caps = resolveCapabilities(m.id, m.caps)
  const chips: CapChip[] = []
  if (resolveToolSupport(m.caps) === true) {
    chips.push({ key: 'tools', glyph: 'T', title: 'Supports tool calling' })
  }
  if (caps.vision) chips.push({ key: 'vision', glyph: 'V', title: 'Accepts images (vision)' })
  if (caps.reasoning) chips.push({ key: 'reasoning', glyph: 'R', title: 'Has a reasoning mode' })
  return chips
}

interface FlatOption {
  providerId: string
  modelId: string
  label: string
}

/**
 * Model selector. Replaces a native <select> with a listbox popover so it can be
 * positioned (opens upward from the bottom-docked control bar) and styled (grouped by
 * provider, context window per model, a check on the current model). Models are shown
 * in a stable curated order via `sortedModels`. Keyboard: ↑/↓/Home/End move the active
 * option, Enter/Space selects, Escape closes; printable keys type-ahead by name.
 */
export function ModelPicker({
  settings,
  selected,
  onSelect
}: {
  settings: AppSettings
  selected: SelectedModel | null
  onSelect: (sel: SelectedModel) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const typeahead = useRef<{ buf: string; at: number }>({ buf: '', at: 0 })

  // Each provider's models in display order, plus a flat list of just the selectable
  // options for keyboard navigation (group headers and empty providers are skipped).
  const groups = useMemo(
    () => settings.providers.map((p) => ({ provider: p, models: sortedModels(p.kind, p.models) })),
    [settings.providers]
  )
  const flat = useMemo<FlatOption[]>(
    () =>
      groups.flatMap(({ provider, models }) =>
        models.map((m) => ({ providerId: provider.id, modelId: m.id, label: m.label ?? m.id }))
      ),
    [groups]
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
  const triggerLabel = selected
    ? `${selectedModel?.label ?? selected.model}${
        selectedModel && windowLabel(selectedModel) ? ` · ${windowLabel(selectedModel)}` : ''
      }`
    : 'Select a model…'

  const openMenu = (): void => {
    const idx = flat.findIndex((f) => `${f.providerId}::${f.modelId}` === selectedKey)
    setActive(idx >= 0 ? idx : 0)
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

  // Keep the active option scrolled into view while arrowing through a long list.
  const reveal = (idx: number): void => {
    setActive(idx)
    requestAnimationFrame(() => {
      document.getElementById(`model-opt-${idx}`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  const typeAhead = (ch: string): void => {
    const t = typeahead.current
    const now = Date.now()
    t.buf = now - t.at > 700 ? ch : t.buf + ch
    t.at = now
    const from = t.buf.length === 1 ? (active + 1) % Math.max(flat.length, 1) : active
    for (let i = 0; i < flat.length; i++) {
      const idx = (from + i) % flat.length
      if (flat[idx].label.toLowerCase().startsWith(t.buf.toLowerCase())) {
        reveal(idx)
        return
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      reveal(Math.min(flat.length - 1, active + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      reveal(Math.max(0, active - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      reveal(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      reveal(flat.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flat[active]) choose(flat[active])
    } else if (e.key === ' ') {
      e.preventDefault()
      // Space extends an in-progress type-ahead (so multi-word labels like
      // "Claude Opus 4.8" are reachable); a lone Space still selects the active
      // option, the standard listbox behavior.
      const t = typeahead.current
      if (t.buf && Date.now() - t.at <= 700) typeAhead(' ')
      else if (flat[active]) choose(flat[active])
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      typeAhead(e.key)
    }
  }

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
          aria-activedescendant={open && flat[active] ? `model-opt-${active}` : undefined}
          aria-describedby={lacksTools ? 'model-tool-warning' : undefined}
          onClick={() => (open ? close() : openMenu())}
          onKeyDown={onKeyDown}
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
          role="listbox"
          ariaLabel="Model"
        >
          {groups.map(({ provider, models }) => (
            <div key={provider.id} role="group" aria-label={groupLabel(provider)}>
              <div className="menu__label">{groupLabel(provider)}</div>
              {models.length === 0 ? (
                <div className="model-menu__empty">— no models configured —</div>
              ) : (
                models.map((m) => {
                  const key = `${provider.id}::${m.id}`
                  const idx = flat.findIndex((f) => `${f.providerId}::${f.modelId}` === key)
                  const isSelected = key === selectedKey
                  const win = windowLabel(m)
                  const chips = capChips(m)
                  return (
                    <button
                      key={key}
                      id={`model-opt-${idx}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-label={win ? `${m.label ?? m.id} ${win}` : (m.label ?? m.id)}
                      className={`model-menu__opt${idx === active ? ' model-menu__opt--active' : ''}${
                        isSelected ? ' model-menu__opt--selected' : ''
                      }`}
                      onMouseMove={() => setActive(idx)}
                      onClick={() => choose({ providerId: provider.id, modelId: m.id, label: m.label ?? m.id })}
                    >
                      <span className="model-menu__check" aria-hidden="true">
                        {isSelected ? '✓' : ''}
                      </span>
                      <span className="model-menu__name">{m.label ?? m.id}</span>
                      <span className="model-menu__meta">
                        {chips.length > 0 && (
                          <span className="model-menu__caps" aria-hidden="true">
                            {chips.map((c) => (
                              <span key={c.key} className="model-cap" title={c.title}>
                                {c.glyph}
                              </span>
                            ))}
                          </span>
                        )}
                        {win && <span className="model-menu__win">{win}</span>}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          ))}
        </Popover>
      )}
    </>
  )
}
