import { callTool, say, turn, type EvalTask } from '../../types'

// The body of transform() as the fixture ships it, replaced whole by the fix.
const ORIGINAL_BODY = [
  '  if (op.type === \'insert\' && against.type === \'insert\') {',
  '    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]',
  '    return [op]',
  '  }',
  '  if (op.type === \'insert\' && against.type === \'delete\') {',
  '    if (op.pos <= against.pos) return [op]',
  '    if (op.pos >= against.pos + against.len) return [{ ...op, pos: op.pos - against.len }]',
  '    return [{ ...op, pos: against.pos }]',
  '  }',
  '  if (op.type === \'delete\' && against.type === \'insert\') {',
  '    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]',
  '    return [op]',
  '  }',
  '  // delete against delete',
  '  if (against.pos + against.len <= op.pos) return [{ ...op, pos: op.pos - against.len }]',
  '  if (op.pos + op.len <= against.pos) return [op]',
  '  return [{ ...op, pos: Math.min(op.pos, against.pos), len: Math.max(0, op.len - against.len) }]'
].join('\n')

/**
 * Operational transform: two people edit one document at once, and each screen
 * applies the other's edit after transforming it. The visible test is the reported
 * divergence (same-offset inserts both shift, because the tie-break ignores the site),
 * and fixing the tie passes it. The holdout checks the contract `transform.mjs`
 * states in full: a concurrent delete around an insert must not swallow the inserted
 * text (the delete has to split around it), overlapping deletes must remove each
 * character once, and 5000 random edit pairs must converge. This one is reasoning
 * more than investigation: the code is short, and the cases are subtle.
 */
export const task: EvalTask = {
  id: 'concurrent-edits-diverge',
  title: 'Make concurrent edits converge in a collaborative editor',
  prompt:
    'In our collaborative editor, two people typed at the same spot at the same moment and ended up looking at different text. `node test.mjs` reproduces it. Fix it. test.mjs is the spec, so do not change it.',
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The rest of the contract transform.mjs states, and a randomized convergence check.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(callTool('c2', 'read_file', { path: 'ot/transform.mjs' }), callTool('c3', 'read_file', { path: 'ot/ops.mjs' })),
    turn(
      callTool('c4', 'edit_file', {
        path: 'ot/transform.mjs',
        old_string: ORIGINAL_BODY,
        new_string: [
        '  if (op.type === \'insert\' && against.type === \'insert\') {',
        '    const first = against.pos < op.pos || (against.pos === op.pos && against.site < op.site)',
        '    return [first ? { ...op, pos: op.pos + against.text.length } : op]',
        '  }',
        '  if (op.type === \'insert\' && against.type === \'delete\') {',
        '    if (op.pos <= against.pos) return [op]',
        '    if (op.pos >= against.pos + against.len) return [{ ...op, pos: op.pos - against.len }]',
        '    return [{ ...op, pos: against.pos }]',
        '  }',
        '  if (op.type === \'delete\' && against.type === \'insert\') {',
        '    if (against.pos <= op.pos) return [{ ...op, pos: op.pos + against.text.length }]',
        '    if (against.pos >= op.pos + op.len) return [op]',
        '    // The insert landed inside this delete: delete around it, the right part first so',
        '    // the left part\'s offsets still hold.',
        '    const leftLen = against.pos - op.pos',
        '    return [',
        '      { ...op, pos: against.pos + against.text.length, len: op.len - leftLen },',
        '      { ...op, pos: op.pos, len: leftLen }',
        '    ]',
        '  }',
        '  // delete against delete: drop what `against` already deleted, then shift by the part',
        '  // of it that came before this delete.',
        '  const start = op.pos',
        '  const end = op.pos + op.len',
        '  const aStart = against.pos',
        '  const aEnd = against.pos + against.len',
        '  const overlap = Math.max(0, Math.min(end, aEnd) - Math.max(start, aStart))',
        '  const before = Math.max(0, Math.min(start, aEnd) - aStart)',
        '  const len = op.len - overlap',
        '  return len ? [{ ...op, pos: start - before, len }] : []'
      ].join('\n')
      })
    ),
    turn(callTool('c5', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        'Inserts at the same offset both shifted, so each screen put the other\'s text first. They now go in site order, lower site first. Two more cases broke the convergence `transform.mjs` promises: a delete around a concurrent insert swallowed the inserted text (it now splits around it), and overlapping deletes miscounted what was left (they now drop exactly the overlap). `node test.mjs` prints ok.'
      )
    )
  ]
}
