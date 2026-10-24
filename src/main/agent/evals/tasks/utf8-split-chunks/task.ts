import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * From Houston's own child-process decoding fix: output decoded chunk by chunk turns a
 * multi-byte character that straddles two chunks into replacement characters. The
 * report is about the build log, but the decode happens in two other files, once for
 * the buffered log and once for the live line view, and both need fixing. The visible
 * test covers the buffered log; the holdout runs the live view, so fixing only the
 * path the repro exercises, without looking for the same mistake next door, fails.
 * The prompt's second complaint, links shown as `]8;;file:///…`, is a separate bug in
 * the ANSI stripper (it ends an OSC sequence only at BEL, and test runners end it with
 * ST); the visible test doesn't reproduce it, the holdout does.
 */
export const task: EvalTask = {
  id: 'utf8-split-chunks',
  title: 'Stop non-ASCII build output turning into replacement characters',
  prompt:
    'Build output that contains non-ASCII text (accents, ✓, CJK, emoji) sometimes shows up garbled in our build log panel, with � where the character should be, even though the tool itself prints it correctly. File links from our test runner come through as junk too, like `]8;;file:///…`. `node test.mjs` reproduces the garbling. Fix it. test.mjs is the spec, so do not change it.',
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The live line view, the second place output is decoded chunk by chunk, and the
  // hyperlinks the prompt says come through as junk.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'buildlog.mjs' }),
      callTool('c3', 'read_file', { path: 'lib/collect.mjs' }),
      callTool('c4', 'read_file', { path: 'lib/follow.mjs' }),
      callTool('c4b', 'read_file', { path: 'lib/ansi.mjs' })
    ),
    turn(
      callTool('c5', 'write_file', {
        path: 'lib/collect.mjs',
        content: [
          "import { StringDecoder } from 'node:string_decoder'",
          '',
          '/** Read a child\'s whole output stream into one string. */',
          'export async function collect(stream) {',
          "  // One decoder for the whole stream: a character split across chunks is held",
          '  // back until its last byte arrives instead of decoding as two halves.',
          "  const decoder = new StringDecoder('utf8')",
          "  let out = ''",
          '  for await (const chunk of stream) {',
          "    out += typeof chunk === 'string' ? chunk : decoder.write(chunk)",
          '  }',
          '  return out + decoder.end()',
          '}',
          ''
        ].join('\n')
      })
    ),
    turn(
      callTool('c6', 'multi_edit', {
        path: 'lib/follow.mjs',
        edits: [
          {
            old_string: 'export async function followLines(stream, onLine) {\n',
            new_string:
              "import { StringDecoder } from 'node:string_decoder'\n\nexport async function followLines(stream, onLine) {\n  const decoder = new StringDecoder('utf8')\n"
          },
          {
            old_string: "    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')",
            new_string: "    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)"
          },
          {
            old_string: "  if (pending) onLine(pending.replace(/\\r$/, ''))",
            new_string: "  pending += decoder.end()\n  if (pending) onLine(pending.replace(/\\r$/, ''))"
          }
        ]
      })
    ),
    turn(
      callTool('c7', 'edit_file', {
        path: 'lib/ansi.mjs',
        old_string: 'const ANSI = /\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\][^\\x07]*\\x07/g',
        new_string: 'const ANSI = /\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g'
      })
    ),
    turn(callTool('c8', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        'Both readers decoded each chunk on its own, so a character split across two chunks became two replacement characters. `collect` and `followLines` now keep one `StringDecoder` per stream and flush it at the end. The links were a separate bug: the ANSI pattern only ended an OSC sequence at BEL, and test runners end hyperlinks with ST (`ESC \\`), so it now accepts either. `node test.mjs` prints ok.'
      )
    )
  ]
}
