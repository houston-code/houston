import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { applyMention, mentionBeforeCursor, type MentionToken } from '../lib/mentions'
import {
  expandTemplate,
  matchCommands,
  parseSlashCommand,
  resolveCommand,
  type Command
} from '@shared/commands'

export function Composer({
  disabled,
  running,
  workspace,
  commands,
  onCommand,
  onSend,
  onCancel
}: {
  disabled: boolean
  running: boolean
  workspace: string | null
  commands: Command[]
  onCommand: (cmd: Command, args: string) => void
  onSend: (text: string) => void
  onCancel: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  // A leading "/name" (no space yet) opens the command menu.
  const cmdPrefix = useMemo(() => {
    const m = text.match(/^\/(\S*)$/)
    return m ? m[1] : null
  }, [text])
  const cmdMatches = useMemo(
    () => (cmdPrefix === null ? [] : matchCommands(commands, cmdPrefix)),
    [cmdPrefix, commands]
  )
  const showCmdMenu = !cmdDismissed && cmdMatches.length > 0

  // Query workspace files for the active @-mention (debounced).
  useEffect(() => {
    if (!mention || !workspace) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.listWorkspaceFiles(workspace, mention.query).then((files) => {
        if (!cancelled) {
          setSuggestions(files)
          setMentionIndex(0)
        }
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [mention, workspace])

  const showMentionMenu = mention !== null && suggestions.length > 0

  const sync = (value: string, cursor: number): void => {
    setText(value)
    setMention(mentionBeforeCursor(value.slice(0, cursor)))
    setCmdDismissed(false)
    setCmdIndex(0)
  }

  const focusEnd = (caret: number): void => {
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(caret, caret)
      }
    })
  }

  const chooseMention = (path: string): void => {
    if (!mention) return
    const { text: next, caret } = applyMention(text, mention, path)
    setText(next)
    setMention(null)
    setSuggestions([])
    focusEnd(caret)
  }

  // Complete the command name into the input; the user adds args, then Enter runs it.
  const chooseCommand = (cmd: Command): void => {
    const next = `/${cmd.name} `
    setText(next)
    setCmdDismissed(true)
    focusEnd(next.length)
  }

  const resetMenus = (): void => {
    setMention(null)
    setSuggestions([])
    setCmdDismissed(false)
    setCmdIndex(0)
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || disabled || running) return
    const parsed = parseSlashCommand(trimmed)
    if (parsed) {
      const cmd = resolveCommand(commands, parsed.name)
      if (cmd) {
        if (cmd.template) {
          // Custom command: expand into the composer so the (workspace-supplied)
          // prompt is visible and editable before the user sends it.
          const expanded = expandTemplate(cmd.template, parsed.args)
          setText(expanded)
          resetMenus()
          focusEnd(expanded.length)
        } else {
          onCommand(cmd, parsed.args)
          setText('')
          resetMenus()
        }
        return
      }
      // Unknown command — fall through and send it as a normal message.
    }
    onSend(trimmed)
    setText('')
    resetMenus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showCmdMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIndex((i) => (i + 1) % cmdMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        chooseCommand(cmdMatches[cmdIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCmdDismissed(true)
        return
      }
    } else if (showMentionMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        chooseMention(suggestions[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        setSuggestions([])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer">
      <div className="composer__field">
        {showCmdMenu && (
          <ul className="mention-menu">
            {cmdMatches.map((cmd, i) => (
              <li
                key={cmd.name}
                className={`mention-item ${i === cmdIndex ? 'mention-item--active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  chooseCommand(cmd)
                }}
              >
                <span className="mention-item__name">/{cmd.name}</span>
                <span className="mention-item__desc">{cmd.description}</span>
              </li>
            ))}
          </ul>
        )}
        {showMentionMenu && (
          <ul className="mention-menu">
            {suggestions.map((path, i) => (
              <li
                key={path}
                className={`mention-item ${i === mentionIndex ? 'mention-item--active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  chooseMention(path)
                }}
              >
                {path}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          className="composer__input"
          placeholder={
            disabled
              ? 'Pick a model and project folder to start…'
              : 'Ask Houston…  (@ to mention a file, / for commands)'
          }
          value={text}
          disabled={disabled}
          rows={1}
          onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
        />
      </div>
      {running ? (
        <button className="btn btn--danger composer__btn" onClick={onCancel}>
          Stop
        </button>
      ) : (
        <button className="btn btn--accent composer__btn" onClick={submit} disabled={disabled || !text.trim()}>
          Send
        </button>
      )}
    </div>
  )
}
