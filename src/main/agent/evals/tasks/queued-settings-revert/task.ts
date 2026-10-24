import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * From Houston PR #448: a queued follow-up kept the settings it was queued with and
 * wrote them back when it ran, undoing a mid-run switch to plan mode. The symptom is
 * in the runner, the cause is the snapshot the queue takes, and the obvious fix
 * (drop the snapshot, run with the chat's settings) breaks the one-off per-message
 * override the snapshot was also carrying. The queue has to keep the override alone
 * and apply it to that run without saving it. The visible test is the reported bug;
 * the override is documented in queue.mjs and checked only by the holdout, the way a
 * regression in a neighbouring feature surfaces after the fix ships. The prompt's
 * second report is a separate bug across the same two files: `removeQueued` replaces
 * the queue array, and `drainQueue` keeps shifting the one it started with.
 */
export const task: EvalTask = {
  id: 'queued-settings-revert',
  title: 'Stop a queued message from undoing a settings change',
  prompt:
    'I switched a busy chat to plan mode while a message was waiting in its queue. The queued message then ran in full-auto anyway, and afterwards the chat had flipped back to full-auto. `node test.mjs` reproduces that. Separately, a queued message I deleted while an earlier one was still running got sent anyway. Fix it. test.mjs is the spec, so do not change it.',
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The per-message override queue.mjs documents, the badges that show it, and the
  // deleted message the prompt reports separately.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'src/queue.mjs' }),
      callTool('c3', 'read_file', { path: 'src/runner.mjs' }),
      callTool('c4', 'read_file', { path: 'src/chat.mjs' })
    ),
    turn(
      callTool('c5', 'multi_edit', {
        path: 'src/queue.mjs',
        edits: [
          {
            old_string: '  const entry = { text, settings: { ...chat.settings, ...override } }',
            // Only the override: the rest of the settings are read when the message runs.
            new_string: '  const entry = { text, override: { ...override } }'
          },
          {
            old_string: '  return chat.queue.map((e) => `${e.text} [${e.settings.mode}, ${e.settings.model}]`)',
            new_string: [
              '  return chat.queue.map((e) => {',
              '    const s = { ...chat.settings, ...e.override }',
              '    return `${e.text} [${s.mode}, ${s.model}]`',
              '  })'
            ].join('\n')
          }
        ]
      }),
      callTool('c6', 'edit_file', {
        path: 'src/runner.mjs',
        old_string: '    chat.setSettings(entry.settings)\n    await runMessage(chat, entry.text, agent)',
        new_string:
          "    // The chat's settings as they are now, plus this message's one-off override,\n    // which applies to this run only and is never saved to the chat.\n    await runMessage(chat, entry.text, agent, { ...chat.settings, ...entry.override })"
      })
    ),
    turn(
      callTool('c6b', 'edit_file', {
        path: 'src/queue.mjs',
        old_string: '  chat.queue = chat.queue.filter((_, i) => i !== index)',
        // In place: the runner may be partway through draining this same array.
        new_string: '  chat.queue.splice(index, 1)'
      })
    ),
    turn(callTool('c7', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "Each queued message stored a full copy of the chat's settings, and `drainQueue` wrote that copy back before running it, so a switch made while it waited was undone. The queue now keeps only the message's own override; the runner applies it on top of the chat's current settings for that run without saving it. Deleting a waiting message replaced the queue array while the runner kept draining the old one, so it now removes the entry in place. `node test.mjs` prints ok."
      )
    )
  ]
}
