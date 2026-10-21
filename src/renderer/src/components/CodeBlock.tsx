import { useMemo, useState, type ReactNode } from 'react'
import { copyText } from '../lib/clipboard'
import { highlightCode } from '../lib/highlight'

/**
 * A fenced code block: language label, Copy, and highlighted source. `label`
 * overrides the language shown (e.g. "html visual"), `actions` adds controls before
 * Copy, and `children` replaces the source view (a rendered visual) while keeping
 * the bar.
 */
export function CodeBlock({
  lang,
  value,
  label,
  actions,
  children
}: {
  lang: string
  value: string
  label?: string
  actions?: ReactNode
  children?: ReactNode
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void copyText(value).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  // hljs escapes its input, so the returned token HTML is safe to inject; a null
  // result (unknown language / too large) falls back to the escaped raw text.
  const highlighted = useMemo(() => (children ? null : highlightCode(lang, value)), [children, lang, value])
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
