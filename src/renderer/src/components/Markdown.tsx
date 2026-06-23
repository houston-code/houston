import { memo, useState } from 'react'
import { parseMarkdown, safeHref, type Block, type Inline } from '../lib/markdown'
import { copyText } from '../lib/clipboard'

/** Render an inline node tree. Keys are positional — the tree is static per render. */
function renderInline(nodes: Inline[]): JSX.Element[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <span key={i}>{n.value}</span>
      case 'strong':
        return <strong key={i}>{renderInline(n.children)}</strong>
      case 'em':
        return <em key={i}>{renderInline(n.children)}</em>
      case 'del':
        return <del key={i}>{renderInline(n.children)}</del>
      case 'code':
        return (
          <code key={i} className="md-code">
            {n.value}
          </code>
        )
      case 'br':
        return <br key={i} />
      case 'link': {
        const href = safeHref(n.href)
        if (!href) return <span key={i}>{renderInline(n.children)}</span>
        return (
          <a key={i} href={href} target="_blank" rel="noreferrer" className="md-link">
            {renderInline(n.children)}
          </a>
        )
      }
    }
  })
}

function CodeBlock({ lang, value }: { lang: string; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void copyText(value).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="md-codeblock">
      <div className="md-codeblock__bar">
        <span className="md-codeblock__lang">{lang || 'text'}</span>
        <button className="md-codeblock__copy" onClick={copy} title="Copy code">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre className="md-codeblock__pre">
        <code>{value}</code>
      </pre>
    </div>
  )
}

function renderBlock(block: Block, key: number): JSX.Element {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${Math.min(block.level, 6)}` as keyof JSX.IntrinsicElements
      return (
        <Tag key={key} className="md-h">
          {renderInline(block.children)}
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {renderInline(block.children)}
        </p>
      )
    case 'code':
      return <CodeBlock key={key} lang={block.lang} value={block.value} />
    case 'hr':
      return <hr key={key} className="md-hr" />
    case 'blockquote':
      return (
        <blockquote key={key} className="md-quote">
          {block.children.map((b, i) => renderBlock(b, i))}
        </blockquote>
      )
    case 'list': {
      const items = block.items.map((it, i) => (
        <li key={i}>{it.blocks.map((b, j) => renderBlock(b, j))}</li>
      ))
      return block.ordered ? (
        <ol key={key} className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {items}
        </ul>
      )
    }
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.align[c] ?? undefined }}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/**
 * Render a markdown string as React. Memoized on the source text so streaming
 * deltas only re-parse when the text actually grows.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = parseMarkdown(text)
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i))}</div>
})
