import { useEffect, useMemo, useState } from 'react'
import {
  SHORTCUTS,
  isCustomizable,
  isMacPlatform,
  formatChord,
  type ShortcutDef
} from '../../lib/shortcuts'
import { chordFromString, chordFromEvent, chordToString } from '../../lib/keybindingOverrides'
import { SettingsSection } from './fields'

/** One customizable shortcut: shows its binding and records a replacement on demand. */
function KeybindRow({
  def,
  binding,
  overridden,
  mac,
  onSet,
  onReset
}: {
  def: ShortcutDef
  binding: string | null
  overridden: boolean
  mac: boolean
  onSet: (value: string | null) => void
  onReset: () => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      // Capture the keystroke for this row only — keep it from triggering app
      // shortcuts or the dialog's focus trap while recording.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return // ignore bare modifier presses; wait for a real key
      onSet(chordToString(chord))
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onSet])

  const chord = binding ? chordFromString(binding) : null
  const label = recording ? 'Press keys…' : chord ? formatChord(chord, mac) : 'Unbound'

  return (
    <div className="keybind-row">
      <span className="keybind-row__label">{def.label}</span>
      <div className="keybind-row__controls">
        <button
          className={`kbd keybind-row__capture${recording ? ' is-recording' : ''}`}
          onClick={() => setRecording((r) => !r)}
          title={recording ? 'Press a shortcut, or Esc to cancel' : 'Click to record a new shortcut'}
        >
          {label}
        </button>
        {binding && !recording && (
          <button className="btn btn--sm" onClick={() => onSet(null)} title="Disable this shortcut">
            Disable
          </button>
        )}
        {overridden && (
          <button className="btn btn--sm" onClick={onReset} title="Restore the default">
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

/** The Keyboard settings tab: the list of rebindable shortcuts. Exported for tests. */
export function KeyboardTab({
  overrides,
  onSet,
  onReset,
  onResetAll
}: {
  overrides: Record<string, string | null> | undefined
  onSet: (id: string, value: string | null) => void
  onReset: (id: string) => void
  onResetAll: () => void
}): JSX.Element {
  const mac = useMemo(() => isMacPlatform(), [])
  const rows = useMemo(() => SHORTCUTS.filter(isCustomizable), [])
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0

  return (
    <SettingsSection
      title="Keyboard shortcuts"
      desc={
        <>
          Click a binding to record a new key combination, or disable it. Press{' '}
          {mac ? '⌘/' : 'Ctrl+/'} (or ?) anytime to see the full list.
        </>
      }
    >
      <div className="keybind-list">
        {rows.map((def) => {
          const overridden = !!overrides && def.id in overrides
          const binding = overridden ? overrides[def.id] : chordToString(def.chords[0])
          return (
            <KeybindRow
              key={def.id}
              def={def}
              binding={binding}
              overridden={overridden}
              mac={mac}
              onSet={(v) => onSet(def.id, v)}
              onReset={() => onReset(def.id)}
            />
          )
        })}
      </div>
      {hasOverrides && (
        <button className="btn btn--sm" onClick={onResetAll}>
          Reset all to defaults
        </button>
      )}
    </SettingsSection>
  )
}
