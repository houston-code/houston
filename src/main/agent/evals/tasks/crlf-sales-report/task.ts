import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * A misleading first failure, and a cause that isn't in any code. The real export
 * crashes with a TypeError inside `toCents`, so the obvious fix is a guard there,
 * which turns the crash into a report of $0.00 totals. The cause is the file: a
 * spreadsheet export with CRLF line endings (the header's last column reads
 * `total\r`) and a UTF-8 byte order mark (the first column reads `\uFEFFdate`).
 * Neither shows up in a plain read, so the agent has to look at the bytes or the
 * parsed header to find them. The hand-written sample keeps passing throughout.
 *
 * The prompt also asks for the October export, which the visible test never runs: its
 * refunds are in the accounting format, "(45.00)", which `toCents` rejects. money.mjs
 * documents the format; the holdout reports October.
 *
 * The exports' line endings are pinned by `.gitattributes` (`-text`): normalizing
 * them to LF would quietly make this task pass on the untouched fixture.
 */
export const task: EvalTask = {
  id: 'crlf-sales-report',
  title: 'Make the sales report read a spreadsheet export',
  prompt:
    "The monthly sales report breaks on the finance team's real export (data/sales-2026-09.csv) while our own sample file works fine. `node test.mjs` reproduces it. The October export (data/sales-2026-10.csv), which has refunds in it, needs to work too. Find the causes and fix the code. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The October export the prompt also asks for: refunds in the accounting format.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(callTool('c2', 'read_file', { path: 'lib/csv.mjs' })),
    turn(
      callTool('c3', 'run_shell', {
        command: `node -e "console.log(JSON.stringify(require('fs').readFileSync('data/sales-2026-09.csv','utf8').split('\\n')[0]))"`
      })
    ),
    turn(
      callTool('c4', 'edit_file', {
        path: 'lib/csv.mjs',
        old_string: "  const lines = text.split('\\n')",
        new_string: [
          '  // Spreadsheet exports start with a byte order mark and end lines with CRLF.',
          "  const lines = text.replace(/^\\uFEFF/, '').split(/\\r?\\n/)"
        ].join('\n')
      })
    ),
    turn(callTool('c5', 'run_shell', { command: 'node test.mjs && node report.mjs data/sales-2026-10.csv' })),
    turn(callTool('c6', 'read_file', { path: 'lib/money.mjs' })),
    turn(
      callTool('c7', 'edit_file', {
        path: 'lib/money.mjs',
        old_string: "  const clean = amount.trim().replace(/^\\$/, '').replace(/,/g, '')",
        new_string: [
          '  // Accounting format: a negative amount is written in parentheses.',
          "  const clean = amount.trim().replace(/^\\((.*)\\)$/, '-$1').replace(/^(-?)\\$/, '$1').replace(/,/g, '')"
        ].join('\n')
      })
    ),
    turn(callTool('c8', 'run_shell', { command: 'node test.mjs && node report.mjs data/sales-2026-10.csv' })),
    turn(
      say(
        "The export has a byte order mark and CRLF line endings, so the parsed header read `\\uFEFFdate` and `total\\r` and every row lost its date and total. `parseCsv` now strips the BOM and splits on `\\r?\\n`. October's refunds are written in the accounting format, `(45.00)`, which `toCents` rejected; it now reads parentheses as negative. `node test.mjs` prints ok and the October report adds up."
      )
    )
  ]
}
