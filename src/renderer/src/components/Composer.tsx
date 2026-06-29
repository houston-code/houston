import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react'
import { Icon, type IconName } from './Icon'
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
  SUPPORTED_IMAGE_TYPES,
  type ImageAttachment
} from '@shared/images'
import {
  buildMessageWithContext,
  formatDiffContext,
  formatFileContext,
  formatFolderContext,
  formatLinkContext,
  humanBytes,
  normalizeLink,
  truncateUtf8,
  MAX_CONTEXT_ATTACHMENTS,
  MAX_DIFF_TEXT_BYTES,
  type ContextAttachment,
  type ContextKind,
  type PickedFile
} from '@shared/composerContext'
import { workingTreeToText, type WorkingTreeChanges } from '@shared/workingTree'

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

/** The icon shown on a context-attachment chip, by kind. */
const KIND_ICON: Record<ContextKind, IconName> = {
  file: 'file',
  folder: 'folder',
  diff: 'diff',
  link: 'link'
}

/** One row in the `+` attachment menu. */
function AttachItem({
  icon,
  label,
  hint,
  disabled,
  onClick
}: {
  icon: IconName
  label: string
  hint?: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="attach-menu__item"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="attach-menu__icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="attach-menu__label">{label}</span>
      {hint && <span className="attach-menu__hint">{hint}</span>}
    </button>
  )
}

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
  // Non-image context (attached files, a folder listing, the working-tree diff, a
  // link) shown as chips and rendered into the outgoing message text on send.
  const [context, setContext] = useState<ContextAttachment[]>([])
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdDismissed, setCmdDismissed] = useState(false)
  // The `+` attachment menu: open/closed, and its inline "add a link" sub-form.
  const [attachOpen, setAttachOpen] = useState(false)
  const [linkMode, setLinkMode] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  // A transient one-line status under the field (e.g. "No uncommitted changes").
  const [notice, setNotice] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // Clear the notice timer on unmount so a pending fade can't fire into a gone tree.
  useEffect(() => () => clearNoticeTimer(), [])

  const clearNoticeTimer = (): void => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = null
  }
  const flashNotice = (msg: string): void => {
    setNotice(msg)
    clearNoticeTimer()
    noticeTimer.current = setTimeout(() => setNotice(null), 3500)
  }

  const addFiles = async (files: File[]): Promise<void> => {
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ImageAttachment => x !== null)
    if (valid.length) setImages((prev) => [...prev, ...valid].slice(0, MAX_ATTACHMENTS))
  }

  const addImage = (img: ImageAttachment): void =>
    setImages((prev) => [...prev, img].slice(0, MAX_ATTACHMENTS))

  const addContext = (att: ContextAttachment): void =>
    setContext((prev) => [...prev, att].slice(0, MAX_CONTEXT_ATTACHMENTS))

  const removeContext = (id: string): void =>
    setContext((prev) => prev.filter((a) => a.id !== id))

  const closeAttach = useCallback((): void => {
    setAttachOpen(false)
    setLinkMode(false)
    setLinkUrl('')
  }, [])

  // Close the `+` menu on an outside click or Escape (Escape backs out of the
  // link sub-form first, then closes the menu).
  useEffect(() => {
    if (!attachOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || plusRef.current?.contains(t)) return
      closeAttach()
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (linkMode) {
        setLinkMode(false)
        setLinkUrl('')
      } else {
        closeAttach()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [attachOpen, linkMode, closeAttach])

  // ---- `+` menu actions ----

  const pickImages = (): void => fileInputRef.current?.click()

  const onPickImagesInput = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? [])
    if (files.length) void addFiles(files)
    e.target.value = '' // allow re-picking the same file
  }

  // Insert an `@` at the caret and focus, opening the existing mention autocomplete.
  const insertMention = (): void => {
    closeAttach()
    const el = ref.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? start
    const next = `${text.slice(0, start)}@${text.slice(end)}`
    sync(next, start + 1)
    focusEnd(start + 1)
  }

  const attachFiles = async (): Promise<void> => {
    closeAttach()
    const files = await window.api.pickAttachmentFiles()
    if (files.length === 0) return
    let added = 0
    for (const f of files) {
      addContext(fileToContext(f))
      added++
    }
    const binary = files.filter((f) => f.binary).length
    if (binary) flashNotice(`Attached ${added} file${added === 1 ? '' : 's'} (${binary} binary, contents omitted)`)
  }

  const addFolder = async (): Promise<void> => {
    closeAttach()
    const dir = await window.api.pickDirectory()
    if (!dir) return
    const files = await window.api.listWorkspaceFiles(dir, '')
    addContext(folderToContext(dir, files))
  }

  const addDiff = async (): Promise<void> => {
    closeAttach()
    if (!workspace) return
    const changes = await window.api.getWorkingTreeChanges(workspace)
    if (!changes.isRepo) {
      flashNotice('Not a git repository')
      return
    }
    if (changes.files.length === 0) {
      flashNotice('No uncommitted changes')
      return
    }
    addContext(diffToContext(changes))
  }

  const pasteClipboard = async (): Promise<void> => {
    closeAttach()
    const { text: clip, image } = await window.api.readClipboard()
    let added = false
    if (image && vision) {
      addImage(image)
      added = true
    }
    if (clip) {
      const el = ref.current
      const start = el?.selectionStart ?? text.length
      const end = el?.selectionEnd ?? start
      const next = text.slice(0, start) + clip + text.slice(end)
      sync(next, start + clip.length)
      focusEnd(start + clip.length)
      added = true
    }
    if (!added) flashNotice(image ? 'Image copied — switch to a vision model to attach it' : 'Clipboard is empty')
  }

  const confirmLink = (): void => {
    const url = normalizeLink(linkUrl)
    if (!url) return
    addContext(linkToContext(url))
    closeAttach()
  }

  // ---- Context-attachment builders ----

  const fileToContext = (f: PickedFile): ContextAttachment => ({
    id: crypto.randomUUID(),
    kind: 'file',
    label: f.name,
    detail: f.binary ? 'binary' : humanBytes(f.bytes) + (f.truncated ? ' · truncated' : ''),
    text: formatFileContext(f.name, f.content, { truncated: f.truncated, binary: f.binary })
  })

  const folderToContext = (dir: string, files: string[]): ContextAttachment => {
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
    const truncated = files.length >= 20 // findFiles caps the listing at 20
    return {
      id: crypto.randomUUID(),
      kind: 'folder',
      label: name,
      detail: `${files.length}${truncated ? '+' : ''} file${files.length === 1 ? '' : 's'}`,
      text: formatFolderContext(dir, files, { truncated })
    }
  }

  const diffToContext = (changes: WorkingTreeChanges): ContextAttachment => {
    const { text: diff, truncated } = truncateUtf8(workingTreeToText(changes), MAX_DIFF_TEXT_BYTES)
    const n = changes.files.length
    return {
      id: crypto.randomUUID(),
      kind: 'diff',
      label: 'Uncommitted changes',
      detail: `${n} file${n === 1 ? '' : 's'} · +${changes.added} −${changes.removed}`,
      text: formatDiffContext(diff, {
        branch: changes.branch,
        files: n,
        added: changes.added,
        removed: changes.removed,
        truncated: truncated || !!changes.truncated
      })
    }
  }

  const linkToContext = (url: string): ContextAttachment => ({
    id: crypto.randomUUID(),
    kind: 'link',
    label: url,
    text: formatLinkContext(url)
  })

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
    const hasAttachments = images.length > 0 || context.length > 0
    if ((!trimmed && !hasAttachments) || disabled) return
    // While a run is in progress the message is queued verbatim as the next
    // input (the app combines all queued messages when the run finishes), so
    // slash commands aren't interpreted — they'd be sent as a prompt anyway.
    if (!running) {
      // Slash commands only when there are no attachments (a message with images
      // or context is always sent as a normal message).
      const parsed = !hasAttachments ? parseSlashCommand(trimmed) : null
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
    onSend(buildMessageWithContext(trimmed, context), images.length ? images : undefined)
    setText('')
    setImages([])
    setContext([])
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

  const sendDisabled = disabled || (!text.trim() && images.length === 0 && context.length === 0)

  return (
    <div className="composer">
      <div className="composer__card" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        {(images.length > 0 || context.length > 0) && (
          <div className="composer__attachments">
            {images.map((img, i) => (
              <div key={`img-${i}`} className="attachment">
                <img className="attachment__thumb" src={imageDataUrl(img)} alt="attachment" />
                <button
                  className="attachment__remove"
                  title="Remove"
                  aria-label="Remove image"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
            {context.map((att) => (
              <div key={att.id} className="ctx-chip" title={att.label}>
                <span className="ctx-chip__icon">
                  <Icon name={KIND_ICON[att.kind]} size={13} />
                </span>
                <span className="ctx-chip__label">{att.label}</span>
                {att.detail && <span className="ctx-chip__detail">{att.detail}</span>}
                <button
                  className="ctx-chip__remove"
                  aria-label={`Remove ${att.label}`}
                  onClick={() => removeContext(att.id)}
                >
                  <Icon name="close" size={10} />
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
        {attachOpen && (
          <div className="attach-menu" role="menu" ref={menuRef}>
            {linkMode ? (
              <form
                className="attach-menu__link"
                onSubmit={(e) => {
                  e.preventDefault()
                  confirmLink()
                }}
              >
                <input
                  className="attach-menu__link-input"
                  type="text"
                  placeholder="https://example.com"
                  aria-label="Link URL"
                  value={linkUrl}
                  autoFocus
                  onChange={(e) => setLinkUrl(e.target.value)}
                />
                <button type="submit" className="btn btn--accent btn--sm" disabled={!linkUrl.trim()}>
                  Add
                </button>
              </form>
            ) : (
              <>
                <div className="attach-menu__group">From your computer</div>
                {vision && (
                  <AttachItem
                    icon="image"
                    label="Upload images"
                    hint="PNG, JPG"
                    onClick={() => {
                      closeAttach()
                      pickImages()
                    }}
                  />
                )}
                <AttachItem icon="file" label="Attach files" hint="code, docs" onClick={attachFiles} />
                <AttachItem icon="folder" label="Add a folder" onClick={addFolder} />
                <div className="attach-menu__group">From the workspace</div>
                <AttachItem icon="at" label="Reference a file" hint="@" onClick={insertMention} />
                <AttachItem
                  icon="diff"
                  label="Add current changes"
                  hint="git diff"
                  disabled={!workspace}
                  onClick={addDiff}
                />
                <div className="attach-menu__group">Capture &amp; web</div>
                <AttachItem icon="clipboard" label="Paste from clipboard" onClick={pasteClipboard} />
                <AttachItem icon="link" label="Add a link" onClick={() => setLinkMode(true)} />
              </>
            )}
          </div>
        )}
        <textarea
          ref={ref}
          className="composer__input"
          placeholder={
            disabled
              ? 'Pick a model and project folder to start…'
              : running
                ? 'Queue a follow-up…  (sent when the current run finishes)'
                : 'Ask Houston…  (@ file, / command, or + to attach)'
          }
          value={text}
          disabled={disabled}
          rows={1}
          onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {notice && <div className="composer__notice">{notice}</div>}
        <div className="composer__bar">
          <div className="composer__bar-left">
            <button
              ref={plusRef}
              type="button"
              className={`composer__tool${attachOpen ? ' composer__tool--active' : ''}`}
              aria-label="Add attachment"
              aria-haspopup="menu"
              aria-expanded={attachOpen}
              disabled={disabled}
              onClick={() => setAttachOpen((o) => !o)}
            >
              <Icon name="plus" size={16} />
            </button>
            {vision && (
              <button
                type="button"
                className="composer__tool"
                aria-label="Attach image"
                disabled={disabled}
                onClick={pickImages}
              >
                <Icon name="image" size={16} />
              </button>
            )}
            <button
              type="button"
              className="composer__tool"
              aria-label="Reference a file"
              disabled={disabled}
              onClick={insertMention}
            >
              <Icon name="at" size={16} />
            </button>
          </div>
          <div className="composer__bar-right">
            {running ? (
              <>
                <button
                  type="button"
                  className="composer__send"
                  aria-label="Queue"
                  title="Queue this message — it’s sent when the current run finishes"
                  onClick={submit}
                  disabled={sendDisabled}
                >
                  <Icon name="send" size={16} />
                </button>
                <button
                  type="button"
                  className="composer__stop"
                  aria-label="Stop"
                  title="Stop the run"
                  onClick={onCancel}
                >
                  <Icon name="stop" size={14} />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="composer__send"
                aria-label="Send"
                onClick={submit}
                disabled={sendDisabled}
              >
                <Icon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <input
        ref={fileInputRef}
        className="composer__file-input"
        type="file"
        accept={SUPPORTED_IMAGE_TYPES.join(',')}
        multiple
        hidden
        onChange={onPickImagesInput}
      />
    </div>
  )
}
