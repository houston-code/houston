import { describe, it, expect } from 'vitest'
import {
  cellSource,
  editNotebook,
  isNotebookPath,
  parseNotebook,
  renderNotebook,
  serializeNotebook,
  toSourceLines,
  type Notebook,
  type NotebookCell
} from './notebook'

const codeCell = (source: string[] | string, extra: Partial<NotebookCell> = {}): NotebookCell => ({
  cell_type: 'code',
  metadata: {},
  source,
  outputs: [],
  execution_count: null,
  ...extra
})

const nb = (cells: NotebookCell[], extra: Record<string, unknown> = {}): Notebook => ({
  cells,
  metadata: { kernelspec: { name: 'python3' } },
  nbformat: 4,
  nbformat_minor: 5,
  ...extra
})

describe('isNotebookPath', () => {
  it('matches .ipynb regardless of case, and nothing else', () => {
    expect(isNotebookPath('a/b/analysis.ipynb')).toBe(true)
    expect(isNotebookPath('Analysis.IPYNB')).toBe(true)
    expect(isNotebookPath('notes.ipynb.bak')).toBe(false)
    expect(isNotebookPath('main.py')).toBe(false)
  })
})

describe('parseNotebook', () => {
  it('parses a v4 notebook', () => {
    const parsed = parseNotebook(JSON.stringify(nb([codeCell('x = 1')])))
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.nbformat).toBe(4)
  })

  it('rejects malformed JSON, non-objects, and a missing cells array', () => {
    expect(() => parseNotebook('{oops')).toThrow(/not valid JSON/i)
    expect(() => parseNotebook('[]')).toThrow(/must be a JSON object/)
    expect(() => parseNotebook('{"nbformat":4}')).toThrow(/missing a top-level "cells" array/)
  })

  it('rejects a format it would misparse rather than guessing', () => {
    expect(() => parseNotebook('{"cells":[],"nbformat":3}')).toThrow(/only nbformat 4/)
    expect(() => parseNotebook('{"cells":[]}')).toThrow(/only nbformat 4/)
  })

  it('names the offending cell when one is not an object', () => {
    expect(() => parseNotebook('{"cells":[{"cell_type":"code","source":""},"nope"],"nbformat":4}')).toThrow(
      /cell 2 is not an object/
    )
  })
})

describe('cellSource / toSourceLines', () => {
  it('collapses the line-array form and passes a plain string through', () => {
    expect(cellSource(codeCell(['def f():\n', '    return 1']))).toBe('def f():\n    return 1')
    expect(cellSource(codeCell('x = 1'))).toBe('x = 1')
  })

  it('splits source into Jupyter line arrays, keeping trailing newlines on all but the last', () => {
    expect(toSourceLines('a\nb')).toEqual(['a\n', 'b'])
    expect(toSourceLines('a\nb\n')).toEqual(['a\n', 'b\n'])
    expect(toSourceLines('solo')).toEqual(['solo'])
    expect(toSourceLines('')).toEqual([])
  })

  it('round-trips source through both directions', () => {
    for (const src of ['a\nb', 'a\nb\n', 'x = 1', '', 'a\n\nb']) {
      expect(cellSource(codeCell(toSourceLines(src)))).toBe(src)
    }
  })
})

describe('renderNotebook', () => {
  it('numbers cells and labels their kind and execution state', () => {
    const out = renderNotebook(
      nb([
        { cell_type: 'markdown', metadata: {}, source: ['# Title'] },
        codeCell('x = 1', { execution_count: 3 }),
        codeCell('y = 2')
      ]),
      { path: 'a.ipynb' }
    )
    expect(out).toContain('3 cells (2 code, 1 markdown)')
    expect(out).toContain('[1] markdown\n# Title')
    expect(out).toContain('[2] code (executed 3)\nx = 1')
    expect(out).toContain('[3] code (unexecuted)\ny = 2')
  })

  it('points the agent at the argument the numbers feed', () => {
    // The read view and notebook_edit are a pair; the header says so explicitly.
    expect(renderNotebook(nb([codeCell('x')]), { path: 'a.ipynb' })).toContain('notebook_edit')
  })

  it('renders stream, result, and error outputs', () => {
    const out = renderNotebook(
      nb([
        codeCell('print("hi")', {
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }]
        }),
        codeCell('1 + 1', {
          outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['2'] }, execution_count: 1 }]
        }),
        codeCell('boom()', {
          outputs: [
            {
              output_type: 'error',
              ename: 'NameError',
              evalue: "name 'boom' is not defined",
              traceback: ['\x1b[0;31mNameError\x1b[0m: boom']
            }
          ]
        })
      ]),
      { path: 'a.ipynb' }
    )
    expect(out).toContain('| stdout: hi')
    expect(out).toContain('| 2')
    expect(out).toContain("| NameError: name 'boom' is not defined")
    // The traceback is shown, with Jupyter's ANSI colouring stripped.
    expect(out).toContain('| NameError: boom')
    expect(out).not.toContain('\x1b[')
  })

  it('leaves bracketed literals in output text alone while stripping ANSI', () => {
    // The ESC byte is what makes an escape an escape; "[0m" as plain text is data.
    const out = renderNotebook(
      nb([codeCell('p()', { outputs: [{ output_type: 'stream', name: 'stdout', text: ['see [0m and [1;32m'] }] })]),
      { path: 'a.ipynb' }
    )
    expect(out).toContain('see [0m and [1;32m')
  })

  it('names an image output instead of dumping its base64', () => {
    const out = renderNotebook(
      nb([
        codeCell('plot()', {
          outputs: [{ output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgoAAAA'.repeat(500) } }]
        })
      ]),
      { path: 'a.ipynb' }
    )
    expect(out).toContain('[image/png output]')
    expect(out).not.toContain('iVBORw0KGgo')
  })

  it('prefers a text/plain fallback over naming the media', () => {
    const out = renderNotebook(
      nb([
        codeCell('df', {
          outputs: [{ output_type: 'execute_result', data: { 'text/html': '<table/>', 'text/plain': ['   a  b'] } }]
        })
      ]),
      { path: 'a.ipynb' }
    )
    expect(out).toContain('|    a  b')
    expect(out).not.toContain('[text/html output]')
  })

  it('bounds a runaway output so it cannot crowd out the code', () => {
    const out = renderNotebook(
      nb([codeCell('spam()', { outputs: [{ output_type: 'stream', name: 'stdout', text: ['x'.repeat(5000)] }] })]),
      { path: 'a.ipynb', maxOutputChars: 100 }
    )
    expect(out).toContain('[output truncated]')
    expect(out.length).toBeLessThan(400)
  })

  it('handles an empty notebook and an empty cell', () => {
    expect(renderNotebook(nb([]), { path: 'a.ipynb' })).toContain('no cells')
    expect(renderNotebook(nb([codeCell('')]), { path: 'a.ipynb' })).toContain('[empty cell]')
  })

  it('ignores an unknown output type rather than throwing', () => {
    const out = renderNotebook(
      nb([codeCell('x', { outputs: [{ output_type: 'from_the_future' }, null] })]),
      { path: 'a.ipynb' }
    )
    expect(out).toContain('[1] code')
  })
})

describe('editNotebook', () => {
  it('replaces a cell\'s source, writing Jupyter\'s line-array form', () => {
    const out = editNotebook(nb([codeCell('x = 1')]), { cell: 1, mode: 'replace', source: 'x = 2\ny = 3' })
    expect(out.cells[0].source).toEqual(['x = 2\n', 'y = 3'])
  })

  it('clears stale outputs when a code cell\'s source changes', () => {
    // The recorded output came from code that no longer exists; keeping it would
    // present a stale result as the current one.
    const before = nb([
      codeCell('print(1)', {
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
        execution_count: 7
      })
    ])
    const out = editNotebook(before, { cell: 1, mode: 'replace', source: 'print(2)' })
    expect(out.cells[0].outputs).toEqual([])
    expect(out.cells[0].execution_count).toBeNull()
  })

  it('does not mutate the notebook it was given', () => {
    const before = nb([codeCell('x = 1')])
    editNotebook(before, { cell: 1, mode: 'replace', source: 'x = 2' })
    expect(cellSource(before.cells[0])).toBe('x = 1')
  })

  it('leaves other cells, metadata, and unknown keys untouched', () => {
    const before = nb([codeCell('a'), codeCell('b', { outputs: [{ output_type: 'stream', text: ['keep'] }] })], {
      some_extension_key: { keep: true }
    })
    const out = editNotebook(before, { cell: 1, mode: 'replace', source: 'a2' })
    expect(out.cells[1].outputs).toEqual([{ output_type: 'stream', text: ['keep'] }])
    expect(out.metadata).toEqual({ kernelspec: { name: 'python3' } })
    expect(out.some_extension_key).toEqual({ keep: true })
    expect(out.nbformat_minor).toBe(5)
  })

  it('inserts a cell at a position, defaulting to the kind already there', () => {
    const before = nb([{ cell_type: 'markdown', metadata: {}, source: ['# T'] }])
    const out = editNotebook(before, { cell: 1, mode: 'insert', source: '## Sub' })
    expect(out.cells).toHaveLength(2)
    expect(out.cells[0].cell_type).toBe('markdown')
    expect(cellSource(out.cells[0])).toBe('## Sub')
    expect(cellSource(out.cells[1])).toBe('# T')
  })

  it('appends when inserting one past the last cell', () => {
    const out = editNotebook(nb([codeCell('a')]), { cell: 2, mode: 'insert', source: 'b', cellType: 'code' })
    expect(out.cells).toHaveLength(2)
    expect(cellSource(out.cells[1])).toBe('b')
    // A fresh code cell carries the fields Jupyter expects.
    expect(out.cells[1].outputs).toEqual([])
    expect(out.cells[1].execution_count).toBeNull()
  })

  it('inserts into an empty notebook, defaulting to code', () => {
    const out = editNotebook(nb([]), { cell: 1, mode: 'insert', source: 'x = 1' })
    expect(out.cells).toHaveLength(1)
    expect(out.cells[0].cell_type).toBe('code')
  })

  it('does not give a markdown cell execution state', () => {
    const out = editNotebook(nb([]), { cell: 1, mode: 'insert', source: '# T', cellType: 'markdown' })
    expect(out.cells[0]).not.toHaveProperty('outputs')
    expect(out.cells[0]).not.toHaveProperty('execution_count')
  })

  it('deletes a cell', () => {
    const out = editNotebook(nb([codeCell('a'), codeCell('b')]), { cell: 1, mode: 'delete' })
    expect(out.cells).toHaveLength(1)
    expect(cellSource(out.cells[0])).toBe('b')
  })

  it('converts a cell to another kind, dropping execution state on the way out', () => {
    const before = nb([codeCell('x = 1', { execution_count: 2, outputs: [{ output_type: 'stream', text: ['1'] }] })])
    const out = editNotebook(before, { cell: 1, mode: 'replace', source: '# Heading', cellType: 'markdown' })
    expect(out.cells[0].cell_type).toBe('markdown')
    expect(out.cells[0]).not.toHaveProperty('outputs')
    expect(out.cells[0]).not.toHaveProperty('execution_count')
  })

  it('rejects an out-of-range or non-integer cell with a message naming the real range', () => {
    const one = nb([codeCell('a')])
    expect(() => editNotebook(one, { cell: 2, mode: 'replace', source: 'x' })).toThrow(
      /Cell 2 does not exist: the notebook has 1 cell/
    )
    expect(() => editNotebook(one, { cell: 0, mode: 'delete' })).toThrow(/numbered from 1/)
    expect(() => editNotebook(one, { cell: 1.5, mode: 'delete' })).toThrow(/numbered from 1/)
    expect(() => editNotebook(one, { cell: 3, mode: 'insert', source: 'x' })).toThrow(
      /last insertable position is 2/
    )
  })

  it('rejects a replace with no source, and an unknown cell type', () => {
    const one = nb([codeCell('a')])
    expect(() => editNotebook(one, { cell: 1, mode: 'replace' })).toThrow(/requires "source"/)
    expect(() => editNotebook(one, { cell: 1, mode: 'replace', source: 'x', cellType: 'sql' })).toThrow(
      /Unknown cell_type "sql"/
    )
    expect(() => editNotebook(one, { cell: 1, mode: 'insert', source: 'x', cellType: 'sql' })).toThrow(
      /Unknown cell_type "sql"/
    )
  })
})

describe('serializeNotebook', () => {
  it('writes Jupyter\'s canonical formatting so a diff stays scoped to the edit', () => {
    const text = serializeNotebook(nb([codeCell('x = 1')]))
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "cells": [')
  })

  it('round-trips through parse unchanged when nothing is edited', () => {
    const original = nb([codeCell(['x = 1\n', 'y = 2'], { execution_count: 1 })])
    expect(parseNotebook(serializeNotebook(original))).toEqual(original)
  })

  it('survives a full read/edit/write cycle', () => {
    const disk = serializeNotebook(nb([codeCell('x = 1'), { cell_type: 'markdown', metadata: {}, source: ['# T'] }]))
    const edited = serializeNotebook(editNotebook(parseNotebook(disk), { cell: 1, mode: 'replace', source: 'x = 42' }))
    const reparsed = parseNotebook(edited)
    expect(cellSource(reparsed.cells[0])).toBe('x = 42')
    expect(cellSource(reparsed.cells[1])).toBe('# T')
    expect(renderNotebook(reparsed, { path: 'a.ipynb' })).toContain('x = 42')
  })
})
