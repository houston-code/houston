import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * Seeded from the stuck runs in real Houston chats, where a command that never exits
 * ate a turn. Every check passes; the process just won't exit, and the suite's guard
 * says only that something is still running. There are four separate
 * leaks in four files: `close()` never stops the cache sweeper, the limiter's
 * `dispose()` clears its buckets but not its refill interval, `flush()` writes the
 * pending audit batch but leaves its timer armed, and the metrics module starts an
 * interval at import that nothing can stop. Fixing three still hangs, and the guard
 * doesn't say what is open, any more than a hung CI job would.
 *
 * The prompt also says the CLI hangs the same way. It does even once all four leaks are
 * fixed: `--help` creates the service and returns without closing it. The holdout runs
 * each CLI path with a timeout, so fixing the service and not checking its other user
 * fails the grade.
 *
 * The guard fails the run after 2s rather than letting it hang, so a naive
 * `node test.mjs` costs the agent seconds, not the shell's 300s timeout.
 */
export const task: EvalTask = {
  id: 'test-process-hangs',
  title: 'Find what keeps the test process alive',
  prompt:
    "Our CI job hangs after `node test.mjs`: every check passes, but the process never exits and the runner kills it at the job timeout. The suite now fails itself when that happens. Our CLI (`node cli.mjs`) has been seen hanging the same way. Fix the cause. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The CLI the prompt says hangs the same way, on each of its paths.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'src/service.mjs' }),
      callTool('c3', 'read_file', { path: 'src/cache.mjs' }),
      callTool('c4', 'read_file', { path: 'src/limiter.mjs' }),
      callTool('c5', 'read_file', { path: 'src/audit.mjs' }),
      callTool('c6', 'read_file', { path: 'src/metrics.mjs' })
    ),
    turn(
      callTool('c7', 'edit_file', {
        path: 'src/service.mjs',
        old_string: '      limiter.dispose()\n      audit.flush()',
        new_string: '      cache.stop()\n      limiter.dispose()\n      audit.flush()'
      }),
      callTool('c8', 'edit_file', {
        path: 'src/limiter.mjs',
        old_string: '    dispose() {\n      buckets.clear()',
        new_string: '    dispose() {\n      clearInterval(refill)\n      buckets.clear()'
      }),
      callTool('c9', 'edit_file', {
        path: 'src/audit.mjs',
        old_string: '  function flush() {\n    if (!pending.length) return',
        new_string: '  function flush() {\n    clearTimeout(timer)\n    timer = null\n    if (!pending.length) return'
      }),
      callTool('c10', 'edit_file', {
        path: 'src/metrics.mjs',
        old_string: '}, 60_000)',
        // A reporter for the life of the process must not be the reason it stays alive.
        new_string: '}, 60_000).unref()'
      })
    ),
    turn(callTool('c11', 'run_shell', { command: 'node test.mjs' })),
    turn(callTool('c12', 'read_file', { path: 'cli.mjs' })),
    turn(
      callTool('c13', 'multi_edit', {
        path: 'cli.mjs',
        edits: [
          {
            old_string: "  if (argv.includes('--help') || argv[0] !== 'get') {\n    console.log(USAGE)\n    return\n  }",
            new_string: [
              '  // Every path closes the service, or its timers keep the process alive.',
              '  try {',
              "    if (argv.includes('--help') || argv[0] !== 'get') {",
              '      console.log(USAGE)',
              '      return',
              '    }'
            ].join('\n')
          },
          {
            old_string: "  const userAt = argv.indexOf('--user')\n  const user = userAt === -1 ? 'cli' : argv[userAt + 1]\n  const res = await service.handle({ user, path: argv[1] })\n  console.log(JSON.stringify(res))\n  await service.close()\n}",
            new_string: [
              "    const userAt = argv.indexOf('--user')",
              "    const user = userAt === -1 ? 'cli' : argv[userAt + 1]",
              '    const res = await service.handle({ user, path: argv[1] })',
              '    console.log(JSON.stringify(res))',
              '  } finally {',
              '    await service.close()',
              '  }',
              '}'
            ].join('\n')
          }
        ]
      })
    ),
    turn(callTool('c14', 'run_shell', { command: 'node cli.mjs --help && node cli.mjs get /items/1' })),
    turn(
      say(
        "Four timers kept the process alive: `close()` never stopped the cache sweeper, the limiter's `dispose()` left its refill interval running, `flush()` left the batch timer armed, and the metrics reporter's interval wasn't unref'd. All four are fixed and `node test.mjs` now exits 0 right after its checks. The CLI hung for a fifth reason: `--help` returned before closing the service, so it now closes it on every path."
      )
    )
  ]
}
