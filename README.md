# Houston

An open-source, local-first **coding agent for macOS**, in the spirit of Claude Code
and Codex — but **bring your own model**. Point it at Claude, GPT, Gemini, any
OpenAI-compatible API, or a local model (Ollama / LM Studio), give it a project
folder, and let it read, edit, search, and run code — every action gated by an
approval flow and confined to a macOS sandbox.

Built with Electron + React + TypeScript. Apple Silicon (arm64).

![Houston icon](build/icon.png)

## Features

- **Any model, your keys.** Anthropic (Claude), OpenAI (GPT), Google (Gemini),
  any OpenAI-compatible endpoint, and local models via Ollama or LM Studio. Add
  custom endpoints and fetch live model lists in Settings.
- **Image attachments.** Drag-drop or paste images (PNG/JPEG/GIF/WebP) into the
  composer to send them to a vision-capable model — screenshots, diagrams,
  mockups. Thumbnails show inline and the images persist with the conversation.
  The agent can also `read_file` an image or PDF in the project and view it
  directly (full vision on Anthropic; other providers get a text placeholder).
- **Agentic tool use.** The agent can `read_file`, `write_file`, `edit_file`,
  `multi_edit`, `list_dir`, `glob`, `search_files`, `run_shell`, `web_fetch`,
  `web_search`, and `todo_write` to actually do the work — not just describe it. When a turn is all
  reads (e.g. open five files at once), they run **concurrently**; anything that
  writes, runs a command, or needs approval stays sequential. Edits are matched
  **resiliently** — if the model's snippet drifts from the file by indentation or
  whitespace, Houston still locates and applies it instead of failing.
  `search_files` ships with a bundled **ripgrep**, so fast content search works
  out of the box without anything installed on your PATH (it falls back to a
  built-in scan if the binary is ever unavailable).
- **Web search.** With a Tavily API key (set in Settings → *Web search*), the
  agent can `web_search` the web for current information. Like `web_fetch`, it
  requires approval since it leaves the machine.
- **@-mention files.** Type `@` in the composer to fuzzy-search project files and
  drop a path into your message — no need to paste or describe where things live.
- **Slash commands.** Type `/` for a command menu: `/new` starts a chat, `/review`
  runs an adversarial review of your changes, and any Markdown file in
  `.houston/commands/` becomes a custom command — its contents are a prompt
  template (`$ARGUMENTS` is filled in with whatever you type after the command name).
- **Research subagents.** The agent can `dispatch_agent` to hand a focused,
  read-only question to a subagent with its own fresh context. The subagent
  reads, globs, and searches the project and reports back — keeping the main
  agent's context clean. Subagents can't edit, run commands, or use the network.
- **Adversarial review.** `review_changes` (or `/review`) reviews your uncommitted
  changes for correctness, security, and quality. It runs an independent read-only
  reviewer per dimension — each in its own fresh context, so they don't inherit the
  author's blind spots — then a skeptical verifier that re-checks every candidate
  finding against the real code and drops the false positives, and reports the
  confirmed ones. The agent can self-review after a substantial change before
  telling you it's done. Same multi-agent shape as Claude Code's review.
- **Custom agents & skills.** Drop a Markdown file in `.houston/agents/` to define
  a specialized read-only subagent (front-matter `description` + a system-prompt
  body) — the main agent can dispatch it by name. Add a `.houston/skills/<name>/SKILL.md`
  to register a skill: its description is surfaced to the agent, which reads the
  full instructions on demand. Same shape as Claude Code's subagents and skills.
- **MCP servers.** Connect Model Context Protocol servers in Settings — a local
  **stdio** process or a remote **HTTP** endpoint (streamable HTTP, with optional
  auth headers). Their tools are offered to the agent namespaced as
  `mcp__<id>__<tool>` and always require approval. Point Houston at the
  filesystem, git, a hosted MCP service, or any other server to extend what the
  agent can do — the same extensibility model as Claude Code.
- **Task list.** For multi-step work the agent keeps a `todo_write` scratchpad,
  rendered live as a checklist in the transcript so you can see the plan and
  watch it tick off items.
- **Rich transcript.** Replies render as full **Markdown** — headings, lists,
  tables, blockquotes, and syntax-styled code blocks with one-click copy. Tool
  activity collapses into a compact, grouped list (one tidy row per call,
  expandable for output and diffs) instead of a wall of cards.
- **Sandboxed execution.** Shell commands run under the macOS **Seatbelt**
  sandbox (`sandbox-exec`), confined to the project directory: writes outside the
  project and (by default) network access are blocked.
- **Background processes.** `run_shell` can start long-running commands (dev
  servers, watchers) in the background and return immediately; the agent polls
  them with `read_shell_output` and stops them with `kill_shell`. They're killed
  when the app quits.
- **Persistent shell session.** Foreground `run_shell` commands share a session
  within a turn: `cd` and exported environment variables carry over to later
  commands (e.g. `cd build` then `make`, or activate a virtualenv once and reuse
  it), so the agent gets "same terminal" behavior.
- **Headless mode.** Run one prompt without the GUI and stream the result to
  stdout — `Houston -p "<prompt>"` (read-only by default; add `--full-auto` to let
  it edit/run, `--json` for machine-readable events). Good for scripts and CI.
  See [Headless / scripting](#headless--scripting).
- **Approval flow.** Choose how much autonomy to grant: *plan mode* (read-only —
  the agent researches and proposes a plan, with writes and shell commands
  blocked), *ask every time*, *auto-approve edits*, or *full auto*. Approve, deny,
  or allow-for-the-run on each tool call. File edits show an inline red/green
  **diff** so you can review exactly what changes before approving.
- **Project guardrails.** A repo can ship a `.houston/settings.json` with its own
  *deny* / *ask* permission rules (checked before your global ones) — e.g. always
  ask before touching `infra/**`. For safety a project file can only *tighten*:
  `allow` rules, hooks, and MCP servers stay in your own global Settings, so
  cloning an untrusted repo can't auto-approve actions or run commands.
- **Permission rules.** Beyond the coarse policy, add fine-grained
  *allow* / *deny* / *ask* rules in Settings, matched on the tool and a glob over
  its target (e.g. allow `run_shell` matching `git *`, deny anything matching
  `*rm -rf*`, always ask before `write_file` under `src/secret/**`). Rules are
  checked before the policy; first match wins.
- **Hooks.** Run your own shell commands around tool calls (Settings → *Hooks*):
  a *PreToolUse* hook can block a call by exiting non-zero, and a *PostToolUse*
  hook's output is fed back to the agent — e.g. auto-format after every edit, or
  run tests after a write. Hooks run sandboxed to the project; the call's context
  is in `$HOUSTON_TOOL_NAME` / `$HOUSTON_TOOL_INPUT`.
- **Undo / redo a turn's file changes.** Houston snapshots each file before and
  after the agent writes it, so when a turn edits files a **Revert** button appears —
  one click restores everything that turn changed (and deletes files it created).
  Changed your mind? **Redo** puts the changes back.
- **Status bar.** A slim bar along the bottom shows what the agent is doing right
  now (Ready / Responding… / Running a tool / Awaiting approval) and the active
  model.
- **Keyboard shortcuts.** ⌘N new chat, ⌘, settings, and Esc to stop a running
  turn or close the settings dialog.
- **Accessible.** The Settings dialog is a proper focus-trapped `dialog` (focus
  moves in on open and restores on close, Tab stays inside, Esc closes), and all
  animations honor the OS *reduce motion* setting.
- **Light & dark themes.** Pick *System*, *Dark*, or *Light* in Settings →
  *Appearance*; *System* follows your macOS appearance and switches live.
- **Resilient streaming.** Transient provider failures (rate limits, overloads,
  dropped connections) are retried with exponential backoff — shown inline as a
  "retrying…" notice — as long as nothing has streamed yet, so a blip mid-run no
  longer throws the whole turn away. If a turn still fails, a **Retry** button
  re-runs it without you re-typing.
- **Secure key storage.** API keys are encrypted with the macOS Keychain
  (Electron `safeStorage`) and never leave the main process or touch the renderer.
- **Persistent conversations**, scoped per project folder. Export any chat to a
  JSON file and import it back (or onto another machine) from the sidebar.
  **Search** the sidebar to find a past chat by its title or anything said in it.
  **Fork** a chat from its ⋯ menu to branch off a copy and explore a different
  direction without disturbing the original.
- **Organize the sidebar.** Pin important chats to a "Pinned" section, and file
  the rest into your own named, collapsible groups via each chat's ⋯ menu. Pins
  and groups persist across restarts.
- **Long sessions stay in budget.** When a conversation grows past a configurable
  token threshold, Houston automatically summarizes the older turns so it never
  overflows the model's context window. The full transcript stays on screen —
  only what's sent to the model is compacted. Tune or disable the threshold in
  Settings → *Context window*.
- **Multiple folders.** Beyond the project folder, add extra directories in
  Settings → *Additional folders* that the agent may read and write; they're
  added to the file tools' allowed roots and the shell sandbox so it can work
  across more than one repo at once.
- **Git-aware.** If the project is a git repo, Houston folds the current branch
  and a short working-tree status into the agent's context each turn, so it knows
  what branch it's on and what's already modified without having to run git first.
- **Project-aware.** Houston loads a small rules hierarchy into the system prompt —
  your global `~/.claude/CLAUDE.md` first, then the project's own `AGENTS.md` /
  `CLAUDE.md` at its root, then any `AGENTS.md` / `CLAUDE.md` found in
  subdirectories (so per-package conventions in a monorepo are picked up
  automatically, shallowest first) — so the agent follows your conventions,
  build/test commands, and house rules without you re-explaining them each time.
  Any rules file can also pull in others with `@path` imports (relative, `~/…`, or
  absolute), the same way Claude Code splits or shares memory files.
- **Token usage & cost at a glance.** The control bar above the composer shows the
  current context size, the output tokens used this session, and an **estimated
  USD cost** (for models with known pricing — Claude/GPT/Gemini; local models show
  none), so you can see how big and how expensive a conversation is getting. The
  model, project folder, approval policy and thinking controls live there too —
  down by the composer, where you're typing.

## Install (prebuilt DMG)

Download `Houston-<version>-arm64.dmg`, open it, and drag **Houston** to
Applications.

> **The build is unsigned** (no Apple Developer ID). The first time you open it,
> macOS Gatekeeper will warn you. Either:
> - Right-click the app → **Open** → **Open**, or
> - Remove the quarantine attribute:
>   ```bash
>   xattr -dr com.apple.quarantine "/Applications/Houston.app"
>   ```
>
> To ship a signed + notarized build, see [Signing & notarization](#signing--notarization).

## First run

1. Open **Settings** (sidebar) and set an API key for at least one provider
   (or point a local endpoint at Ollama/LM Studio — no key needed).
2. Pick a **project folder** (control bar, above the composer).
3. Choose a **model** and an **approval policy** (same control bar).
4. Ask it to build or change something.

## Headless / scripting

Run a single prompt without opening the window — useful for scripts, pipelines,
and CI. Pass `-p`/`--prompt` to the app binary:

```bash
# read-only by default (plan mode): analysis / Q&A, no edits or commands
/Applications/Houston.app/Contents/MacOS/Houston -p "Summarize the architecture" --cwd ~/code/myproj

# let it edit files and run commands (still sandboxed to the project)
Houston -p "Add a unit test for utils/date.ts and run the suite" --cwd . --full-auto

# machine-readable: one JSON object per agent event
Houston -p "List the TODOs" --json
```

Flags: `--cwd <dir>` (project folder, default the current directory),
`--provider <id>` / `--model <id>` (default your selected model), `--approval
<plan|ask|auto-edit|full-auto>` (default `plan`), `--json`. Assistant text streams
to stdout, tool activity to stderr, and the process exits non-zero on error. It
reuses your saved settings and Keychain-stored API keys.

## Develop

```bash
npm install
npm run dev      # hot-reloading dev build
```

Useful scripts:

```bash
npm run build    # typecheck + bundle to out/
npm test         # unit tests (vitest: node + jsdom projects)
npm run test:e2e # Electron smoke test (Playwright; needs `npm run build` first)
npm run icon     # regenerate the app icon (build/icon.png + icon.icns)
```

## Build a DMG

```bash
npm run dist     # → release/Houston-<version>-arm64.dmg
```

Every PR set to auto-merge also builds the `.app` + `.dmg` in CI (on a macOS
runner, against the merged state), smoke-tests the built app with Playwright,
and uploads the artifacts as `houston-mac-arm64` on the workflow run — grab a
build from the **Actions** tab without building locally.

## Updates

Packaged builds check for updates on launch via `electron-updater`, against the
GitHub Releases feed configured in [`electron-builder.yml`](electron-builder.yml)
(`publish:`), and log when a newer version is available. (No-op in dev; set
`HOUSTON_DISABLE_UPDATER=1` to turn it off.)

It does **not** auto-download or silently install: this build is unsigned, so
there's no Developer ID signature for `electron-updater` to verify against, and
silently installing remote packages would make the release pipeline an RCE
boundary. Grab the newer DMG from **Releases** manually. Once the app is
[signed + notarized](#signing--notarization), enable `autoDownload` /
`autoInstallOnAppQuit` in [`src/main/updater.ts`](src/main/updater.ts) so the
signature check is meaningful. Update metadata is published by running
`npm run dist` with a `GH_TOKEN` and `--publish`, or by attaching the DMG and the
generated `latest-mac.yml` to a release.

## Architecture

```
src/
├── shared/        types + IPC channel names shared by all processes
│   ├── agent.ts       chat/tool/stream protocol + agent run + conversation types
│   ├── types.ts       settings, providers, approval policy
│   └── defaults.ts    built-in provider seeds
├── main/          Electron main process (Node)
│   ├── providers/     Anthropic / OpenAI / Gemini / OpenAI-compatible adapters
│   ├── agent/         tool definitions + the tool-calling loop + system prompt
│   │                  (incl. compaction.ts — summarize old turns to fit context;
│   │                   rules.ts — load project AGENTS.md / CLAUDE.md)
│   ├── sandbox.ts     macOS Seatbelt profile + sandboxed command runner
│   ├── secrets.ts     Keychain-encrypted API-key storage
│   ├── store.ts       settings persistence
│   ├── conversations.ts  conversation persistence (one JSON per chat)
│   └── ipc.ts         all IPC handlers
├── preload/       contextBridge — the typed `window.api` surface
└── renderer/      React UI (transcript, model picker, settings, approvals)
```

The renderer talks to the main process only through the preload bridge. Provider
adapters translate a single internal chat/tool protocol to and from each SDK, so
the agent loop and UI never depend on a specific provider.

## Security model

- **Tool execution is sandboxed.** `run_shell` runs under `sandbox-exec` with a
  generated profile: deny-by-default, filesystem reads allowed, writes restricted
  to the project + temp dirs, network denied unless in *full auto*.
- **File tools are contained** to the workspace in code — any path that resolves
  outside the project root is rejected.
- **Human in the loop.** Writes and shell commands require approval unless you
  opt into a more autonomous policy. `web_fetch` network egress always prompts on
  first use — even in *full auto* — since it leaves the machine; choose
  *allow-for-the-run* to stop further prompts that run.
- **Keys at rest** are encrypted via the OS Keychain; only ciphertext is written
  to disk (`0600`), and the renderer only ever sees a `hasKey` flag.

Coding agents run model-authored commands. Treat *full auto* + network with the
same caution you'd treat running untrusted code, and prefer the default
*ask*/*auto-edit* policies.

## Signing & notarization

The build is ad-hoc signed because there's no Developer ID configured. To sign
and notarize, set `mac.identity` in [`electron-builder.yml`](electron-builder.yml)
to your Developer ID and add a notarization step (e.g. `@electron/notarize` via
an `afterSign` hook), then `npm run dist`.

## Roadmap

What's intentionally not done yet — out of scope for a local-first macOS desktop
app, or a larger effort — is tracked in [ROADMAP.md](./ROADMAP.md) with the
rationale for each.
