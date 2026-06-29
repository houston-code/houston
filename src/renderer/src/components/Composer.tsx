import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react'
import { loadComposerDraft, saveComposerDraft } from '../lib/composerDraft'
import { applyMention, mentionBeforeCursor, type MentionToken } from '../lib/mentions'
import {
  appendPromptHistory,
  historyDown,
  historyUp,
  loadPromptHistory
} from '../lib/promptHistory'
import {
  expandTemplate,
  matchCommands,
  parseSlashCommand,
  resolveCommand,
  type Command
} from '@shared/commands'
import {
  MAX_ATTACHMENTS,
  exceedsImageSizeLimit,
  imageDataUrl,
  isSupportedImageType,
  type ImageAttachment
} from '@shared/images'

/** Read an image File into a base64 ImageAttachment, or null if unsupported. */
function readImageFile(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    if (!isSupportedImageType(file.type)) {
      resolve(null)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) {
        resolve(null)
        return
      }
      const data = result.slice(comma + 1)
      // Match the main-process cap so the UI never shows an image that would be
      // dropped before sending/persisting.
      resolve(exceedsImageSizeLimit(data) ? null : { mediaType: file.type, data })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** Max gap between the two Esc presses that recalls the last message. */
const DOUBLE_ESC_MS = 500

export function Composer({
  conversationId,
  disabled,
  running,
  workspace,
  commands,
  vision = true,
  lastUserMessage,
  onCommand,
  onSend,
  onCancel
}: {
  /** The open conversation (null for a not-yet-created new chat); keys the draft. */
  conversationId: string | null
  disabled: boolean
  running: boolean
  workspace: string | null
  commands: Command[]
  /** Whether the selected model accepts image inputs; gates the paste/drop affordance. */
  vision?: boolean
  /** Text of the most recent user turn — recalled into the field on Esc Esc (empty field). */
  lastUserMessage?: string
  onCommand: (cmd: Command, args: string) => void
  onSend: (text: string, images?: ImageAttachment[]) => void
  onCancel: () => void
}): JSX.Element {
  // Seed from this conversation's persisted draft so text typed but not sent
  // survives a restart. App.tsx keys the Composer by conversation, so this only
  // runs when the open chat changes — loading that chat's own draft.
  const [text, setText] = useState(() => loadComposerDraft(conversationId))
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Prompt-history recall (Up/Down when the field is empty). `histPos` is null when
  // not navigating, otherwise an index into the snapshot taken when recall began;
  // `histDraft` preserves whatever was typed before recall so Down can restore it.
  const histSnapshot = useRef<string[]>([])
  const histDraft = useRef('')
  const [histPos, setHistPos] = useState<number | null>(null)
  // Timestamp of the last Escape, for detecting the Esc-Esc "edit last message" chord.
  const lastEscAt = useRef(0)

  // If the user switches to a model that can't see images, drop any pending
  // attachments so they aren't silently sent to a model that will ignore them.
  useEffect(() => {
    if (!vision) setImages((prev) => (prev.length ? [] : prev))
  }, [vision])

  // Persist the unsent draft (per conversation) so it survives an app restart.
  // Every path that changes the field goes through setText, so watching `text`
  // covers both saving as the user types and clearing on submit (setText('') →
  // removeItem). `conversationId` is fixed for the component's lifetime (App.tsx
  // keys the Composer by it), so the draft is always saved under the open chat.
  useEffect(() => {
    saveComposerDraft(conversationId, text)
  }, [conversationId, text])

  const addFiles = async (files: File[]): Promise<void> => {
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ImageAttachment => x !== null)
    if (valid.length) setImages((prev) => [...prev, ...valid].slice(0, MAX_ATTACHMENTS))
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!vision) return // model can't see images — let the paste fall through as text
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!vision) return
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  // A leading "/name" (no space yet) opens the command menu.
  const cmdPrefix = useMemo(() => {
    const m = text.match(/^\/(\S*)$/)
    return m ? m[1] : null
  }, [text])
  const cmdMatches = useMemo(
    () => (cmdPrefix === null ? [] : matchCommands(commands, cmdPrefix)),
    [cmdPrefix, commands]
  )
  // While a run is active, messages are queued verbatim — the command menu would
  // only mislead (Enter queues the text instead of running a command).
  const showCmdMenu = !cmdDismissed && cmdMatches.length > 0 && !running

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
    // Editing the field leaves history-recall mode; the text is a fresh draft now.
    setHistPos(null)
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

  // Show the history entry at `pos`, or restore the pre-recall draft when `pos`
  // reaches the end (the live-draft sentinel).
  const showHistory = (snapshot: string[], pos: number): void => {
    const atDraft = pos >= snapshot.length
    const value = atDraft ? histDraft.current : snapshot[pos]
    setText(value)
    setHistPos(atDraft ? null : pos)
    focusEnd(value.length)
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
    setHistPos(null)
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || disabled) return
    // While a run is in progress the message is queued verbatim as the next
    // input (the app combines all queued messages when the run finishes), so
    // slash commands aren't interpreted — they'd be sent as a prompt anyway.
    if (!running) {
      // Slash commands only when there are no attachments (a message with images
      // is always sent as a normal message).
      const parsed = images.length === 0 ? parseSlashCommand(trimmed) : null
      if (parsed) {
        const cmd = resolveCommand(commands, parsed.name)
        if (cmd) {
          if (cmd.template) {
            const expanded = expandTemplate(cmd.template, parsed.args)
            if (cmd.autoRun) {
              // Action template (e.g. /review): run it straight away — send the
              // expanded prompt as a normal turn instead of dropping it in the field.
              appendPromptHistory(trimmed)
              onSend(expanded)
              setText('')
              setImages([])
              resetMenus()
            } else {
              // Custom command: expand into the composer so the (workspace-supplied)
              // prompt is visible and editable before the user sends it.
              setText(expanded)
              resetMenus()
              focusEnd(expanded.length)
            }
          } else {
            appendPromptHistory(trimmed)
            onCommand(cmd, parsed.args)
            setText('')
            resetMenus()
          }
          return
        }
        // Unknown command — fall through and send it as a normal message.
      }
    }
    if (trimmed) appendPromptHistory(trimmed)
    onSend(trimmed, images.length ? images : undefined)
    setText('')
    setImages([])
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
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
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
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
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
    // Esc Esc on an empty field recalls the last user message for editing (the
    // edit-previous-message convention). A single Esc still falls through to the
    // app handler (stop the run / close a dialog).
    if (e.key === 'Escape' && !showCmdMenu && !showMentionMenu) {
      const now = Date.now()
      const isDouble = now - lastEscAt.current <= DOUBLE_ESC_MS
      lastEscAt.current = now
      if (isDouble && text.trim() === '' && lastUserMessage) {
        e.preventDefault()
        setHistPos(null)
        setText(lastUserMessage)
        focusEnd(lastUserMessage.length)
      }
      return
    }

    // Prompt-history recall with Up/Down — only when no menu is open. Recall starts
    // from an empty field (so Up still moves the caret in a non-empty draft) and,
    // once started, Up/Down walk through history until Down returns to the draft.
    if (!showCmdMenu && !showMentionMenu) {
      if (e.key === 'ArrowUp') {
        if (histPos !== null) {
          e.preventDefault()
          showHistory(histSnapshot.current, historyUp(histSnapshot.current.length, histPos))
          return
        }
        if (text.trim() === '') {
          const snapshot = loadPromptHistory()
          if (snapshot.length > 0) {
            histSnapshot.current = snapshot
            histDraft.current = text
            e.preventDefault()
            showHistory(snapshot, historyUp(snapshot.length, snapshot.length))
            return
          }
        }
      } else if (e.key === 'ArrowDown' && histPos !== null) {
        e.preventDefault()
        showHistory(histSnapshot.current, historyDown(histSnapshot.current.length, histPos))
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
      <div className="composer__field" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        {images.length > 0 && (
          <div className="composer__attachments">
            {images.map((img, i) => (
              <div key={i} className="attachment">
                <img className="attachment__thumb" src={imageDataUrl(img)} alt="attachment" />
                <button
                  className="attachment__remove"
                  title="Remove"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
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
              : running
                ? 'Queue a follow-up…  (sent when the current run finishes)'
                : vision
                  ? 'Ask Houston…  (@ file, / command, or drop/paste an image)'
                  : 'Ask Houston…  (@ file or / command)'
          }
          value={text}
          disabled={disabled}
          rows={1}
          onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      {running ? (
        <>
          <button
            className="btn btn--accent composer__btn"
            onClick={submit}
            disabled={disabled || (!text.trim() && images.length === 0)}
            title="Queue this message — it’s sent when the current run finishes"
          >
            Queue
          </button>
          <button className="btn btn--danger composer__btn" onClick={onCancel}>
            Stop
          </button>
        </>
      ) : (
        <button
          className="btn btn--accent composer__btn"
          onClick={submit}
          disabled={disabled || (!text.trim() && images.length === 0)}
        >
          Send
        </button>
      )}
    </div>
  )
}
