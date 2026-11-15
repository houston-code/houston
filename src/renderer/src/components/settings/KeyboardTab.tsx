import { useEffect, useMemo, useState } from 'react'
import {
  SHORTCUTS,
  isCustomizable,
  isMacPlatform,
  formatChord,
  type KeyChord,
  type ShortcutDef
} from '../../lib/shortcuts'
import { chordFromString, chordFromEvent, chordToString, resolveShortcuts } from '../../lib/keybindingOverrides'
import { SettingsSection } from './fields'

/** Marks the capture button of the shortcut being recorded (see {@link isRecordingShortcut}). */
const RECORDING_ATTR = 'data-recording-shortcut'

/**
 * Whether a shortcut is being recorded under `root`. Settings' own keys (⌘F, `/`)
 * stand aside then, so the keystroke is recorded instead of moving to the search box.
 */
export function isRecordingShortcut(root: ParentNode = document): boolean {
  return root.querySelector(`[${RECORDING_ATTR}]`) !== null
}

/**
 * Whether two chords are pressed with the same keys. An unset Shift reads as no
 * Shift, and off macOS the raw Control key is the command key too.
 */
function sameChord(a: KeyChord, b: KeyChord, mac: boolean): boolean {
  const norm = (c: KeyChord): string => {
    const mod = !!c.mod || (!mac && !!c.ctrl)
    const ctrl = mac && !!c.ctrl
    return [mod, ctrl, !!c.alt, !!c.shift, c.key.toLowerCase()].join('|')
  }
  return norm(a) === norm(b)
}

/** A just-recorded binding another shortcut already uses, waiting on Replace or Cancel. */
interface Conflict {
  value: string
  chord: KeyChord
  other: ShortcutDef
  /** The other shortcut can be unbound from here (fixed ones can't). */
  replaceable: boolean
}

/** One customizable shortcut: shows its binding and records a replacement on demand. */
function KeybindRow({
  def,
  binding,
  overridden,
  mac,
  recording,
  onRecord,
  findConflict,
  onSet,
  onReplace,
  onReset
}: {
  def: ShortcutDef
  binding: string | null
  overridden: boolean
  mac: boolean
  recording: boolean
  onRecord: (on: boolean) => void
  /** The other shortcut already bound to `chord`, if any. */
  findConflict: (chord: KeyChord) => ShortcutDef | null
  onSet: (value: string | null) => void
  /** Bind `value` here and unbind it from `otherId`. */
  onReplace: (value: string, otherId: string) => void
  onReset: () => void
}): JSX.Element {
  const [conflict, setConflict] = useState<Conflict | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      // Capture the keystroke for this row only — keep it from triggering app
      // shortcuts or the dialog's focus trap while recording.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        onRecord(false)
        return
      }
      const chord = chordFromEvent(e, mac)
      if (!chord) return // ignore bare modifier presses; wait for a real key
      const value = chordToString(chord)
      const other = findConflict(chord)
      onRecord(false)
      if (other) setConflict({ value, chord, other, replaceable: isCustomizable(other) })
      else onSet(value)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onSet, onRecord, findConflict, mac])

  const chord = binding ? chordFromString(binding) : null
  const shown = chord ? formatChord(chord, mac) : 'Unbound'
  const label = recording ? 'Press keys…' : shown

  return (
    <div className="keybind-row">
      <span className="keybind-row__label">{def.label}</span>
      <div className="keybind-row__controls">
        <button
          className={`kbd keybind-row__capture${recording ? ' is-recording' : ''}`}
          {...(recording ? { [RECORDING_ATTR]: '' } : {})}
          aria-pressed={recording}
          aria-label={
            recording ? `${def.label}: press the new shortcut, or Esc to cancel` : `${def.label}: ${shown}. Click to change`
          }
          onClick={() => {
            setConflict(null)
            onRecord(!recording)
          }}
          // Clicking or tabbing away ends recording, so a later keystroke elsewhere
          // isn't swallowed and bound.
          onBlur={() => {
            if (recording) onRecord(false)
          }}
          title={recording ? 'Press a shortcut, or Esc to cancel' : 'Click to record a new shortcut'}
        >
          {label}
        </button>
        {binding && !recording && (
          <button
            className="btn btn--sm"
            onClick={() => onSet(null)}
            title="Disable this shortcut"
            aria-label={`Disable ${def.label}`}
          >
            Disable
          </button>
        )}
        {overridden && (
          <button className="btn btn--sm" onClick={onReset} title="Restore the default" aria-label={`Reset ${def.label}`}>
            Reset
          </button>
        )}
      </div>
      {conflict && (
        <p className="keybind-row__conflict" role="alert">
          {formatChord(conflict.chord, mac)} is already used by {conflict.other.label}
          {conflict.replaceable ? '.' : ', which can’t be changed.'}{' '}
          {conflict.replaceable && (
            <button
              className="btn btn--sm"
              onClick={() => {
                onReplace(conflict.value, conflict.other.id)
                setConflict(null)
              }}
            >
              Replace
            </button>
          )}{' '}
          <button className="btn btn--sm" onClick={() => setConflict(null)}>
            Cancel
          </button>
        </p>
      )}
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
  // Only one row records at a time: starting another ends the first.
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const effective = useMemo(() => resolveShortcuts(overrides ?? undefined), [overrides])

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
              recording={recordingId === def.id}
              onRecord={(on) => setRecordingId((cur) => (on ? def.id : cur === def.id ? null : cur))}
              findConflict={(chord) =>
                effective.find(
                  (other) =>
                    other.id !== def.id &&
                    (other.scope ?? 'global') === 'global' &&
                    other.chords.some((c) => sameChord(c, chord, mac))
                ) ?? null
              }
              onSet={(v) => onSet(def.id, v)}
              onReplace={(v, otherId) => {
                onSet(otherId, null)
                onSet(def.id, v)
              }}
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
