import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * From Houston's own apply_patch fixes (#341 rejected the `*** End of File` line; an
 * earlier fix made the `\ No newline at end of file` marker parse). The visible test
 * has the two failures the prompt describes: an End of File hunk that won't parse, and
 * an anchored hunk that lands in the wrong function. Accepting the marker isn't enough,
 * since the hunk's context also appears earlier in the file and has to match at the end.
 * The holdout has the `\ No newline` marker and an anchor that isn't in the file, which
 * must fail rather than apply somewhere else.
 */
export const task: EvalTask = {
  id: 'patch-envelope-markers',
  title: 'Make the patch applier honor every envelope marker',
  prompt:
    'Some patches our tool generates fail to apply with our patch applier, and one that did apply changed the wrong function. `node test.mjs` reproduces both. Fix the applier. test.mjs is the spec, so do not change it.',
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The other envelope marker parse.mjs documents, and an anchor that isn't there.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(callTool('c2', 'read_file', { path: 'patch/parse.mjs' }), callTool('c3', 'read_file', { path: 'patch/apply.mjs' })),
    turn(
      callTool('c4', 'edit_file', {
        path: 'patch/parse.mjs',
        old_string: "    } else if (op?.type === 'update' && line === '') {",
        new_string: [
          "    } else if (op?.type === 'update' && line === '*** End of File') {",
          "      if (!hunk) throw new Error(`line ${i + 1}: \"*** End of File\" outside a hunk`)",
          '      hunk.atEof = true',
          "    } else if (line.startsWith('\\\\ No newline at end of file')) {",
          "      // Diff metadata about the line before, not a line of the file.",
          "    } else if (op?.type === 'update' && line === '') {"
        ].join('\n')
      }),
      callTool('c5', 'edit_file', {
        path: 'patch/apply.mjs',
        old_string: '    const at = find(lines, before, cursor)\n',
        new_string: [
          '    let from = cursor',
          '    if (hunk.anchor) {',
          '      const a = lines.findIndex((l, i) => i >= cursor && l.trim() === hunk.anchor)',
          '      if (a === -1) throw new Error(`anchor ${JSON.stringify(hunk.anchor)} not found in ${path}`)',
          '      from = a + 1',
          '    }',
          '    // An End of File hunk matches only where its lines end the file.',
          '    const end = lines.length - before.length',
          '    const at = hunk.atEof ? (end >= from && find(lines, before, end) === end ? end : -1) : find(lines, before, from)',
          ''
        ].join('\n')
      })
    ),
    turn(callTool('c6', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        'Four cases failed. The parser rejected `*** End of File` and `\\ No newline at end of file`: the first now marks its hunk as pinned to the end of the file, and the second is skipped as metadata. The applier ignored both the End of File flag and `@@` anchors, so it matched the first occurrence of the context. It now searches after the anchor line (and errors if the anchor is missing), and an End of File hunk only matches at the end. `node test.mjs` prints ok.'
      )
    )
  ]
}
