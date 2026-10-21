import { memo } from 'react'
import { parseMarkdown, safeHref, type Block, type Inline } from '@shared/markdown'
import { visualKind } from '../lib/visuals'
import { CodeBlock } from './CodeBlock'
import { VisualBlock } from './VisualBlock'

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

function renderBlock(block: Block, key: number, visuals: boolean): JSX.Element {
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
    case 'code': {
      const kind = visuals ? visualKind(block.lang, block.info) : null
      return kind ? (
        <VisualBlock key={key} kind={kind} block={block} />
      ) : (
        <CodeBlock key={key} lang={block.lang} value={block.value} />
      )
    }
    case 'hr':
      return <hr key={key} className="md-hr" />
    case 'blockquote':
      return (
        <blockquote key={key} className="md-quote">
          {block.children.map((b, i) => renderBlock(b, i, visuals))}
        </blockquote>
      )
    case 'list': {
      const items = block.items.map((it, i) => (
        <li key={i}>{it.blocks.map((b, j) => renderBlock(b, j, visuals))}</li>
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
 * deltas only re-parse when the text actually grows. With `visuals`, svg, mermaid,
 * and html blocks render as inline visuals (see lib/visuals.ts); leave it off for
 * text that comes from outside the conversation's own replies (MCP prompts).
 */
export const Markdown = memo(function Markdown({ text, visuals = false }: { text: string; visuals?: boolean }): JSX.Element {
  const blocks = parseMarkdown(text)
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i, visuals))}</div>
})
