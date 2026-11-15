import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fitColumns, renderMarkdownAnsi } from './markdown-ansi'
import { makePainter } from './tui'
import { isLinkableFile, markdownLinks, webLinkUrl, workspaceFileUrl, type MarkdownLinks } from './tui-links'
import { filterTerminalOutput, truncateVisible, visibleWidth, wrapAnsi } from './tui-wrap'

const paint = makePainter(false)
const ESC = '\x1b'
const link = (url: string, text: string): string => `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`

const root = mkdtempSync(join(tmpdir(), 'tui-links-'))
mkdirSync(join(root, 'src'))
writeFileSync(join(root, 'src', 'a.ts'), 'x')
writeFileSync(join(root, 'package.json'), '{}')
afterAll(() => rmSync(root, { recursive: true, force: true }))
const fileUrl = (rel: string): string => pathToFileURL(join(root, rel)).href

describe('webLinkUrl', () => {
  it('takes http(s) and mailto links written in plain ASCII', () => {
    expect(webLinkUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(webLinkUrl('mailto:dev@example.com')).toBe('mailto:dev@example.com')
  })

  it('refuses other schemes, anchors, spaces, non-ASCII and controls', () => {
    expect(webLinkUrl('javascript:alert(1)')).toBeNull()
    expect(webLinkUrl('file:///etc/passwd')).toBeNull()
    expect(webLinkUrl('#top')).toBeNull()
    expect(webLinkUrl('https://a b')).toBeNull()
    expect(webLinkUrl('https://exämple.com')).toBeNull()
    expect(webLinkUrl(`https://a${ESC}\\b`)).toBeNull()
    expect(webLinkUrl(`https://a/${'x'.repeat(3000)}`)).toBeNull()
  })
})

describe('workspaceFileUrl', () => {
  it('links an existing file inside the folder, relative or absolute, dropping a line suffix', () => {
    expect(workspaceFileUrl('src/a.ts', root)).toBe(fileUrl('src/a.ts'))
    expect(workspaceFileUrl('./src/a.ts:12', root)).toBe(fileUrl('src/a.ts'))
    expect(workspaceFileUrl('src/a.ts#L3-L9', root)).toBe(fileUrl('src/a.ts'))
    expect(workspaceFileUrl(join(root, 'package.json'), root)).toBe(fileUrl('package.json'))
  })

  it('refuses a missing file, a directory, a climb out, a scheme and control characters', () => {
    expect(workspaceFileUrl('src/missing.ts', root)).toBeNull()
    expect(workspaceFileUrl('src', root)).toBeNull()
    expect(workspaceFileUrl('../outside.ts', root, () => true)).toBeNull()
    expect(workspaceFileUrl('/etc/passwd', root, () => true)).toBeNull()
    expect(workspaceFileUrl('https://x/a.ts', root, () => true)).toBeNull()
    expect(workspaceFileUrl('src/a\x07.ts', root, () => true)).toBeNull()
    expect(workspaceFileUrl('', root)).toBeNull()
  })
})

describe('isLinkableFile', () => {
  it('never links a file a click would run', () => {
    writeFileSync(join(root, 'go.command'), 'x')
    writeFileSync(join(root, 'tool.js'), 'x')
    writeFileSync(join(root, 'run-me'), 'x')
    chmodSync(join(root, 'run-me'), 0o755)
    expect(isLinkableFile(join(root, 'go.command'))).toBe(false)
    expect(isLinkableFile(join(root, 'tool.js'), 'darwin')).toBe(true)
    expect(isLinkableFile(join(root, 'tool.js'), 'win32')).toBe(false)
    // Windows has no execute bit to read.
    if (process.platform !== 'win32') expect(isLinkableFile(join(root, 'run-me'), 'darwin')).toBe(false)
    expect(isLinkableFile(join(root, 'src', 'a.ts'))).toBe(true)
    expect(workspaceFileUrl('go.command', root)).toBeNull()
  })
})

describe('markdown links in the terminal', () => {
  const links: MarkdownLinks = markdownLinks(root)
  const render = (src: string, width = 0, l: MarkdownLinks | null = links): string =>
    renderMarkdownAnsi(src, { paint, width, ...(l ? { links: l } : {}) })

  it('makes a web link clickable and keeps its target in view', () => {
    expect(render('see [the docs](https://example.com/docs)')).toBe(
      `see ${link('https://example.com/docs', 'the docs')} (https://example.com/docs)`
    )
  })

  it('links a relative link to a workspace file, and leaves other targets plain', () => {
    expect(render('[a](src/a.ts)')).toBe(`${link(fileUrl('src/a.ts'), 'a')} (src/a.ts)`)
    expect(render('[x](javascript:alert(1))')).not.toContain(`${ESC}]8`)
    expect(render('[gone](src/nope.ts)')).not.toContain(`${ESC}]8`)
  })

  it('links file paths in inline code and in prose, only when the file exists', () => {
    expect(render('open `src/a.ts` now')).toBe(`open ${link(fileUrl('src/a.ts'), 'src/a.ts')} now`)
    expect(render('`package.json`')).toBe(link(fileUrl('package.json'), 'package.json'))
    expect(render('edit src/a.ts:4 then')).toBe(`edit ${link(fileUrl('src/a.ts'), 'src/a.ts:4')} then`)
    expect(render('edit src/other.ts and `npm test`')).not.toContain(`${ESC}]8`)
  })

  it('prints no hyperlinks without a links source (no TTY, screen-reader mode)', () => {
    const out = render('[d](https://example.com) and `src/a.ts`', 0, null)
    expect(out).toBe('d (https://example.com) and src/a.ts')
  })

  it('lets the hyperlinks it built through the output filter', () => {
    const out = render('[d](https://example.com)')
    expect(filterTerminalOutput(out)).toBe(out)
  })

  it('wraps a linked paragraph by its visible text', () => {
    const out = render(`word ${'`src/a.ts`'} ${'more '.repeat(6).trim()}`, 20)
    for (const line of out.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(20)
  })
})

describe('hyperlink-aware measuring', () => {
  const l = link('https://example.com', 'hello')

  it('counts only a link’s text', () => {
    expect(visibleWidth(l)).toBe(5)
    expect(wrapAnsi(`${l} world`, 20)).toBe(`${l} world`)
  })

  it('ends a link a truncation cuts through', () => {
    const cut = truncateVisible(link('https://example.com', 'a long label'), 6)
    expect(cut.endsWith(`${ESC}]8;;${ESC}\\`)).toBe(true)
    expect(visibleWidth(cut)).toBe(6)
  })
})

describe('tables and code at the terminal width', () => {
  const render = (src: string, width: number): string => renderMarkdownAnsi(src, { paint, width })

  it('narrows the widest columns to fit, wrapping cells inside them', () => {
    const table = [
      '| name | description |',
      '| --- | --- |',
      `| a | ${'lorem ipsum '.repeat(8).trim()} |`
    ].join('\n')
    const out = render(table, 40)
    const lines = out.split('\n')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    // The long cell spans several rows, all under its own column.
    expect(lines.length).toBeGreaterThan(3)
    expect(out.replace(/\s+/g, ' ')).toContain('lorem ipsum')
  })

  it('leaves a table that fits alone, and one that cannot fit at its natural widths', () => {
    expect(fitColumns([4, 5], 80)).toEqual([4, 5])
    expect(fitColumns([30, 30], 40)).toEqual([18, 19])
    expect(fitColumns([10, 10, 10, 10, 10], 20)).toEqual([10, 10, 10, 10, 10])
    expect(fitColumns([50], 0)).toEqual([50])
  })

  it('wraps a long code line under its gutter', () => {
    const out = render(`\`\`\`\n${'x'.repeat(50)}\n\`\`\``, 22)
    const lines = out.split('\n')
    expect(lines.length).toBe(3)
    for (const line of lines) {
      expect(line.startsWith('│ ')).toBe(true)
      expect(visibleWidth(line)).toBeLessThanOrEqual(22)
    }
  })
})
