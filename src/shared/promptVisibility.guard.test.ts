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
    'main/ipc.ts': { count: 2, why: 'the GUI send (carries the renderer-supplied invokedAs) and the composer !cmd record, tagged via shellEscapeTurn' },
    'main/agent/drain.ts': { count: 1, why: 'flushes queued input; a lone queued prompt keeps its invokedAs' },
    'main/tui.ts': { count: 2, why: 'the terminal turn (carries invokedAs) and the !shell escape record' },
    'main/spawnSession.ts': { count: 1, why: "a spawned session's brief, tagged via spawnedTurn" },
    'main/headless.ts': { count: 1, why: 'the headless CLI prompt, which the user wrote' },
    'main/acp.ts': { count: 1, why: "an ACP editor's session/prompt: the user's words, or a slash command's turn carrying its invokedAs" },
    'main/agent/loop.ts': { count: 2, why: "the user's own mid-run steers, and PreCompact context sent only to the summarizer" },
    'main/agent/compaction.ts': {
      count: 3,
      why: 'summarizer request (its instruction, and adjacent user turns merged into one for it), and the summary turn the transcript labels itself'
    },
    'main/agent/subagent.ts': { count: 2, why: "a subagent's own transcript, never shown as the user's" },
    'main/agent/title.ts': { count: 1, why: 'the title-generation request, never persisted' },
    'main/agent/gitActions.ts': { count: 1, why: 'the commit-message suggestion request, never persisted' },
    'main/agent/suggest.ts': { count: 1, why: 'the suggested-next-message request, never persisted' },
    'main/agent/untrusted.ts': { count: 2, why: 'the isolated reader request and its return type, never persisted' },
    'main/agent/workingMemory.ts': { count: 1, why: 'the pinned-memory block, spliced into requests only' },
    'main/agent/evals/probes/kit.ts': { count: 1, why: "a behavior probe's seeded request, eval-only and never shown in a client" },
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
    // The steer loop: `for (const { text: content } of steers) messages.push({ role: 'user', content, steered: true, at: ... })`
    expect(pushes).toHaveLength(1)
    expect(loop).toMatch(
      /for \(const \{ text: content \} of steers\) messages\.push\(\{ role: 'user', content, steered: true, at: new Date\(\)\.toISOString\(\) \}\)/
    )
  })

  // Every renderer call that starts or queues a turn.
  const RENDERER_SEND_SITES: Record<string, { count: number; why: string }> = {
    'renderer/src/App.tsx': {
      count: 16,
      why: 'sendNow/dispatch/onSend/onInvoke plumbing, the ship + /agent + side-chat "Send to main" + project-card /init + Changes-view review-comment invocations, the mid-run steer, its idle send, and its off-chat queue (user text), and Retry on the last reply (resends that user message as it was, keeping its invokedAs), and invokeInChat for a main-prepared custom command (onRunCommand) and the proposal card "Do it here" button (sent in view, or started detached in the chat it was asked in, forwarding invokedAs)'
    },
    'renderer/src/components/Composer.tsx': { count: 3, why: 'the /review invocation and two sends of composer text' },
    'renderer/src/hooks/useChat.ts': {
      count: 2,
      why: 'startAgent for the chat in view and startDetached for one the user has left (a retried or first message), both forwarding invokedAs'
    },
    'renderer/src/lib/midRunMessage.ts': { count: 1, why: 'a mid-run message sent as its own turn once the run ended (user text)' },
    'renderer/src/hooks/useInputQueue.ts': {
      count: 2,
      why: 'queueInput, forwarding invokedAs, and steerAgent (user text only)'
    }
  }

  it('knows every place the renderer starts or queues a turn', () => {
    expect(
      occurrences(['renderer/src'], /\b(onSend|sendNow|dispatch|onInvoke|invokeInChat|chat\.send|queue\s*\.(?:enqueue|steer)|startAgent|queueInput|steerAgent)\(/)
    ).toEqual(counts(RENDERER_SEND_SITES))
  })

  it('builds first-party prompts only through promptInvocation', () => {
    // The prompt sources: the review template, the /agent dispatch wording (also
    // what a custom command's `agent` frontmatter sends), and the /<skill-name>
    // template, which reaches a turn only as a command template through commandTurn.
    // tui.ts only re-exports agentInvocationPrompt for older importers. In commands.ts
    // the review template is also what reviewPrompt returns for a bare /review, and
    // commandTurn (promptInvocation.ts) recognizes it to read /review's argument as the
    // review target, sending reviewPrompt's text instead. An `@agent-<name>` mention
    // sends the same dispatch through mentionTurn.
    expect(
      occurrences(['main', 'renderer/src', 'shared'], /\b(REVIEW_TEMPLATE|agentInvocationPrompt|skillCommandTemplate)\b/)
    ).toEqual({
      'shared/commands.ts': 6,
      'shared/promptInvocation.ts': 6,
      'main/agent/skills.ts': 2,
      'main/tui.ts': 2
    })
    // A connected MCP server's prompt reaches a turn only through mcpPromptTurn, built in
    // prepareMcpPromptRun, which every client (terminal, ACP, the desktop's main-process
    // prepare) calls; the turn's message carries the server as its taintSource.
    expect(occurrences(['main', 'renderer/src', 'shared'], /\bmcpPromptTurn\(/)).toEqual({
      'shared/promptInvocation.ts': 1,
      'main/agent/mcpPromptCommands.ts': 1
    })
    expect(occurrences(['main', 'renderer/src', 'shared'], /\bprepareMcpPromptRun\(/)).toEqual({
      'main/agent/mcpPromptCommands.ts': 1,
      'main/tui.ts': 1,
      'main/acp.ts': 1,
      'main/ipc.ts': 1
    })
    // A ship action's prompt is read only by shipTurn; the renderer's other
    // `.prompt` is a tool argument shown to the user: propose_session's brief on its
    // card (sent only via proposalHereTurn). spawn_session's prompt labels its tool
    // row in shared/toolLabel.ts, which both clients use. SubagentPanel shows the task
    // a subagent was given (its setup tab and transcript), display only, never sent.
    // Settings > Scheduled Runs shows a schedule's stored task, display only: a fired
    // run is started by the scheduler service in main, never sent from the renderer.
    expect(occurrences(['renderer/src'], /\.prompt\b/)).toEqual({
      'renderer/src/components/ProposalCard.tsx': 1,
      'renderer/src/components/SubagentPanel.tsx': 2,
      'renderer/src/components/settings/sections/schedules.tsx': 1
    })
    // shared/visibleText.ts reads spawn_session, dispatch_writable_agent and
    // schedule_run prompts only to show them in an approval prompt, never to send them.
    expect(occurrences(['shared'], /\ba\.prompt\b/)).toEqual({
      'shared/toolLabel.ts': 1,
      'shared/visibleText.ts': 3
    })
    expect(occurrences(['shared'], /\baction\.prompt\b/)).toEqual({ 'shared/promptInvocation.ts': 1 })
  })
})
