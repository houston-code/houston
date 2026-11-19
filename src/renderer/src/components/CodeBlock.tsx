import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { copyText } from '../lib/clipboard'
import { highlightCode } from '../lib/highlight'
import { useTransientFlag } from '../hooks/useTransientFlag'

/**
 * True around text that is still arriving: a reply while it streams. There, a fenced
 * block whose closing fence hasn't come yet is still being written.
 */
export const StreamingTextContext = createContext(false)

/**
 * A fenced code block: language label, Copy, and highlighted source. `label`
 * overrides the language shown (e.g. "html visual"), `actions` adds controls before
 * Copy, and `children` replaces the source view (a rendered visual) while keeping
 * the bar.
 *
 * `open` marks a block whose closing fence hasn't arrived. While the text around it is
 * still streaming (see {@link StreamingTextContext}) it shows as plain text: each delta
 * would otherwise highlight the whole block again, and every version of it would fill
 * the highlight cache. It is highlighted once its fence closes, or once the text stops
 * arriving without one (a cut-off reply), and only a closed block is cached.
 */
export function CodeBlock({
  lang,
  value,
  label,
  actions,
  children,
  open = false
}: {
  lang: string
  value: string
  label?: string
  actions?: ReactNode
  children?: ReactNode
  open?: boolean
}): JSX.Element {
  const [copied, showCopied] = useTransientFlag(1200)
  const copy = (): void => {
    void copyText(value).then((ok) => {
      if (ok) showCopied()
    })
  }
  const streaming = useContext(StreamingTextContext)
  const writing = open && streaming
  // hljs escapes its input, so the returned token HTML is safe to inject; a null
  // result (unknown language / too large / still being written) falls back to the
  // escaped raw text.
  const highlighted = useMemo(
    () => (children || writing ? null : highlightCode(lang, value, { remember: !open })),
    [children, writing, open, lang, value]
  )
  return (
    <div className="md-codeblock">
      <div className="md-codeblock__bar">
        <span className="md-codeblock__lang">{label ?? (lang || 'text')}</span>
        {actions}
        <button className="md-codeblock__copy" onClick={copy} title="Copy code">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      {children ?? (
        <pre className="md-codeblock__pre">
          {highlighted !== null ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{value}</code>}
        </pre>
      )}
    </div>
  )
}
