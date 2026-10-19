import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Keeps prompts Houston writes from showing up as text the user typed.
 *
 * Once a turn is on screen as a user bubble, nothing stops it reading as the
 * user's own words, so the protection has to happen where turns are created. The
 * types do most of it: the GUI's `onInvoke` and the terminal's `prompt` slash
 * result both require an `InvokedTurn`, which only the constructors in
 * `promptInvocation.ts` produce. These checks catch the rest: a new place that
 * starts a turn, or a first-party prompt reaching a send path some other way.
 *
 * When one fails, decide what the new site is:
 *  - text the user wrote → add it to the inventory below with the reason;
 *  - a prompt Houston wrote on the user's behalf → build it with a
 *    `promptInvocation.ts` constructor and send it as an invoked turn;
 *  - a message the loop adds on its own → use `systemNoteMessage()`.
 * A site that disappears fails too, so the inventory stays an accurate map.
 */

const SRC = resolve(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.(test|eval)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** `file → occurrences` for every non-test source file under `dirs` matching `re`. */
function occurrences(dirs: string[], re: RegExp, skip: (file: string) => boolean = () => false): Record<string, number> {
  const out: Record<string, number> = {}
  for (const dir of dirs) {
    for (const file of sourceFiles(join(SRC, dir))) {
      const rel = relative(SRC, file).split('\\').join('/')
      if (skip(rel)) continue
      const n = readFileSync(file, 'utf8').match(new RegExp(re.source, 'g'))?.length ?? 0
      if (n) out[rel] = n
    }
  }
  return out
}

const counts = (inventory: Record<string, { count: number; why: string }>): Record<string, number> =>
  Object.fromEntries(Object.entries(inventory).map(([file, { count }]) => [file, count]))

describe('prompt visibility guard', () => {
  // Every `user`-role message built in the main process. Provider adapters are
  // skipped: they translate messages that already exist into a wire format.
  const USER_MESSAGE_SITES: Record<string, { count: number; why: string }> = {
    'main/ipc.ts': { count: 1, why: 'the GUI send; carries the renderer-supplied invokedAs' },
    'main/agent/drain.ts': { count: 1, why: 'flushes queued input; a lone queued prompt keeps its invokedAs' },
    'main/tui.ts': { count: 2, why: 'the terminal turn (carries invokedAs) and the !shell escape record' },
    'main/spawnSession.ts': { count: 1, why: "a spawned session's brief, tagged via spawnedTurn" },
    'main/headless.ts': { count: 1, why: 'the headless CLI prompt, which the user wrote' },
    'main/agent/loop.ts': { count: 2, why: "the user's own mid-run steers, and PreCompact context sent only to the summarizer" },
    'main/agent/compaction.ts': {
      count: 3,
      why: 'summarizer request (its instruction, and adjacent user turns merged into one for it), and the summary turn the transcript labels itself'
    },
    'main/agent/subagent.ts': { count: 2, why: "a subagent's own transcript, never shown as the user's" },
    'main/agent/title.ts': { count: 1, why: 'the title-generation request, never persisted' },
    'main/agent/untrusted.ts': { count: 2, why: 'the isolated reader request and its return type, never persisted' },
    'main/agent/workingMemory.ts': { count: 1, why: 'the pinned-memory block, spliced into requests only' },
    'shared/agent.ts': { count: 1, why: 'systemNoteMessage, the one constructor for loop-injected notes' }
  }

  it('knows every place the main process builds a user message', () => {
    expect(occurrences(['main', 'shared'], /role: 'user'/, (f) => f.startsWith('main/providers/'))).toEqual(
      counts(USER_MESSAGE_SITES)
    )
  })

  it('injects loop messages only as system notes', () => {
    // A loop-injected message that skips systemNoteMessage reopens as a bubble the
    // user appears to have written (how the Stop-hook and verify turns used to).
    const loop = readFileSync(join(SRC, 'main/agent/loop.ts'), 'utf8')
    const pushes = loop.match(/messages\.push\(\{\s*role: 'user'/g) ?? []
    expect(pushes).toHaveLength(1) // the steer loop: `for (const content of steers) messages.push({ role: 'user', content })`
    expect(loop).toMatch(/for \(const content of steers\) messages\.push\(\{ role: 'user', content \}\)/)
  })

  // Every renderer call that starts or queues a turn.
  const RENDERER_SEND_SITES: Record<string, { count: number; why: string }> = {
    'renderer/src/App.tsx': {
      count: 10,
      why: 'sendNow/dispatch/onSend/onInvoke plumbing, the ship + /agent + proposal "Do it here" + side-chat "Send to main" invocations, and the steer fallback (user text)'
    },
    'renderer/src/components/Composer.tsx': { count: 3, why: 'the /review invocation and two sends of composer text' },
    'renderer/src/hooks/useChat.ts': { count: 1, why: 'startAgent, forwarding invokedAs' },
    'renderer/src/hooks/useInputQueue.ts': { count: 1, why: 'queueInput, forwarding invokedAs' }
  }

  it('knows every place the renderer starts or queues a turn', () => {
    expect(
      occurrences(['renderer/src'], /\b(onSend|sendNow|dispatch|onInvoke|chat\.send|queue\.enqueue|startAgent|queueInput)\(/)
    ).toEqual(counts(RENDERER_SEND_SITES))
  })

  it('builds first-party prompts only through promptInvocation', () => {
    // The prompt sources: the review template and the /agent dispatch wording.
    // tui.ts only re-exports agentInvocationPrompt for older importers.
    expect(occurrences(['main', 'renderer/src', 'shared'], /\b(REVIEW_TEMPLATE|agentInvocationPrompt)\b/)).toEqual({
      'shared/commands.ts': 3,
      'shared/promptInvocation.ts': 2,
      'main/tui.ts': 2
    })
    // A ship action's prompt is read only by shipTurn; the renderer's other
    // `.prompt`s are tool arguments shown to the user: spawn_session's in a tool
    // row, and propose_session's brief on its card (sent only via proposalHereTurn).
    expect(occurrences(['renderer/src'], /\.prompt\b/)).toEqual({
      'renderer/src/lib/toolDisplay.ts': 1,
      'renderer/src/components/ProposalCard.tsx': 1
    })
    expect(occurrences(['shared'], /\baction\.prompt\b/)).toEqual({ 'shared/promptInvocation.ts': 1 })
  })
})
