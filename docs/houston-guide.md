# Houston: product guide

This is Houston's own reference for how Houston works. When the user asks how to
do something *in Houston itself* (its slash commands, skills, subagents, hooks,
plugins, MCP servers, approval modes, permission rules, plan mode, sandboxing,
GitHub tools, settings, or keyboard shortcuts), answer from this guide rather
than describing a generic assistant. Relay the relevant part concisely and point
at the exact setting or file. If a detail is not covered here, say so instead of
guessing, and offer to look it up in the project.

## What Houston is

Houston is a coding agent that runs on your own machine and works inside a single
project folder.

- **Your models.** You bring the model connection: your own API keys, or a model
  running locally.
- **Real tools.** It reads and edits files, runs shell commands, searches code and
  the web, and works with GitHub.
- **You decide what runs.** A permission system sets how much happens without
  asking you first.
- **Desktop or terminal.** It ships as a desktop app and as terminal clients.

## Clients (where Houston runs)

Houston runs in six places. All of them share one agent core, so tools,
permissions, and skills behave the same everywhere.

| Client | Start it with | Good for |
| --- | --- | --- |
| Desktop app | the app | everyday work, with diffs, previews, and panels |
| Interactive terminal | `houston -i` | a chat that lives in your terminal |
| Headless | `houston -p "<prompt>"` | scripts and CI |
| Standalone CLI | `houston` (Node script) | headless Linux servers |
| GitHub Action | `houston-code/houston/action` | answering mentions, reviews, fixing CI |
| Editor integration | `houston --acp` | editors that support ACP agents |

**Desktop-only surfaces.** The sidebar, the Preview panel, the integrated terminal
and Files panel, rendered diagrams, and the tools that need a browser engine
(`view_localhost` and `render_mockup`). Spawned sessions run in every client, but
only the desktop app lists them in a sidebar.

### Desktop app

The full GUI:

- a chat sidebar and diffs
- a right-hand dock with the live **Preview** and a **Tasks** list of background
  commands (stop them, read their output, see which port each one holds)
- Settings

**Chat status.** Each chat in the sidebar has a status dot:

| Dot | Means |
| --- | --- |
| amber | it's waiting on you (an approval, a question, a plan to review) |
| grey pulse | it's working |
| red | its last run failed |
| blue | it has a reply you haven't seen |

- **Read and unread.** A chat's ⋯ menu (or ⌥U / Alt+U) marks it unread or read. The
  filter menu marks every chat read, or sorts the ones that want attention first.
- **Picking up where you left off.** A reply's hover actions include **Mark unread from
  here**, and reopening an unread chat lands on a "New" divider above the first reply
  you haven't seen.
- **Seeing what's waiting at a glance.** A collapsed group's header, the collapsed
  sidebar, and the app icon count what's waiting (the Dock badge on macOS, a dot on the
  Windows taskbar button; turn it off under Settings, Notifications). A "N need you"
  pill in the title bar opens the next chat waiting on you, and clicking a desktop
  notification opens the chat it's about.

### Interactive terminal

`houston -i` keeps a chat open in your terminal.

- The conversation streams live, and you answer approvals and questions inline.
- Slash commands switch settings mid-session.
- `--continue` reopens this folder's most recent chat at launch; `--resume <id>`
  reopens a specific one.

See "The terminal composer" for how to type, paste, and edit a message.

### Headless

`houston -p "<prompt>"` runs one prompt, writes the result to stdout, and exits.
Each model round's text is written once that round has finished.

- **Read-only by default.** Add `--full-auto` to let it edit files and run commands.
- **Machine-readable output.** Add `--json` for one JSON line per event.

**Nobody is there to answer**, so a headless run handles prompts itself:

- **Approvals.** `--on-approval <allow|deny|fail>` decides what a gated tool call
  gets. The default is `deny` (`allow` under `--full-auto`). `fail` also exits
  non-zero, so a script can tell the run hit a permission wall.
- **Questions.** The agent isn't offered `ask_user`. It is told no user is
  available, makes the call itself, and states its assumptions in the final answer.
- **Shell network.** Approving a shell command with `--on-approval allow` is a plain
  "Allow", so the command runs without network. Pass `--allow-shell-network` to let
  shell commands reach the network for the run (see "Shell sandbox and network").

#### Prompt from stdin

- `-p -` reads the prompt from stdin.
- So does `-p` with no value when input is piped in: `cat task.md | houston -p --json`.
- The standalone CLI also reads a piped prompt with no `-p` at all.

#### Per-run settings

These apply to one run and never change your saved settings. A bad value exits
with code 2 before anything runs.

| Flag | Effect |
| --- | --- |
| `--effort <off\|low\|medium\|high\|xhigh>` | reasoning effort |
| `--max-turns <n>` | caps the model steps (a hard cap that never auto-extends) |
| `--max-cost <usd>` | the agent wraps up once the run's estimated cost reaches this (a soft ceiling: the step in flight still finishes) |
| `--verify <command>` | runs this command when the agent stops after editing files, and sends a failure back for a bounded fix-up pass (needs a policy that can edit, such as `--full-auto`) |

#### Resuming a chat

`--continue` (this folder's most recent chat) or `--resume <id>` runs on that chat's
own model and reasoning effort, unless `--provider`, `--model`, or `--effort` says
otherwise.

The approval mode always comes from the flags (read-only unless `--full-auto`),
never from the chat. A chat you use in full auto can't loosen an unattended run.

#### Automation flags

- **`--allowed-tools <list>` / `--disallowed-tools <list>`** restrict the run's
  tools. Each entry is a tool name (`read_file`), a name ending in `*`
  (`mcp__github__*`), or a name with a permission-rule pattern (`run_shell(git *)`).
  - Tools out of scope aren't offered, and a call out of scope is refused under every
    policy, `full-auto` included.
  - Disallowed wins over allowed.
  - The scope only narrows: an allowed call still needs whatever approval the policy
    and rules require.
- **`--append-system-prompt <text|@file>`** adds instructions for the run in their
  own marked section of the system prompt.
- **`--output-schema <file|json>`** makes the final answer a JSON value matching that
  JSON Schema. Houston checks it and gives the agent one round to correct a miss.
- **`--mcp-config <file>`** adds MCP servers for this run only: the `mcpServers`
  shape of `.houston/settings.json`, at most 10. Their tools are named
  `mcp__run-<id>__<tool>`.
- **`--input-format stream-json`** (with `--json`) reads one
  `{"type":"user","content":"..."}` line per turn from stdin. Each turn starts after
  the previous one finishes, until end of input.

#### `--json` output

Lines arrive in this order:

1. **Init:** `{"type":"system","subtype":"init", "schemaVersion", "houstonVersion",
   "cwd", "providerId", "model", "approvalPolicy", "onApproval", "inputFormat",
   "tools"?, ...}`
2. **Session:** a `session` line, when the run is saved.
3. **Events:** one JSON line per agent event.
4. **Result:** a summary (one per turn with stream-json input):
   `{"type":"result", "schemaVersion", "status", "stopReason", "limitReason"?,
   "turns", "costUsd", "inputTokens", "outputTokens", "durationMs", "finalText",
   "receipt"?, "structured_output"?, "schemaErrors"?, "error"?}`

In the result line:

- `status` is `success`, `limit`, `stalled`, `approval_denied`, `error`,
  `schema_invalid`, or `input_error`.
- `finalText` is the agent's closing answer (the text after its last tool call).
- `receipt` is Houston's record of what the run actually ran (see "What actually
  ran"), present when it ran checks or changed files.
- `structured_output` is the answer parsed against `--output-schema`.

Every line is described by `docs/schemas/headless-events.schema.json` in the
repository.

#### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | the agent finished on its own |
| 1 | an error or aborted run, a stalled agent, or a call refused under `--on-approval fail` |
| 2 | a usage error (a bad flag value, an unreadable flag file, or an empty prompt on stdin; nothing ran), or a bad stream-json input line |
| 3 | the run hit a budget before finishing (its step cap or the model's output limit) |
| 4 | the final answer still didn't match `--output-schema` after the corrective round |

### Standalone CLI

The same `-p`, `-i`, and `--acp` clients as one self-contained Node script, with no
desktop app and no browser engine.

- Runs on headless Linux servers.
- API keys come from environment variables.

### GitHub Action

`houston-code/houston/action` runs the standalone CLI in GitHub Actions, on your own
runners, with your own model key from a repository secret. There is no Houston
service.

It has three modes:

- **`respond`** answers an `@houston` mention from someone with write access, as a
  reply.
- **`review`** posts one review comment on a same-repository pull request, from
  `review_changes`.
- **`fix-ci`** fixes a failed workflow run, pushes the fix to a new `houston/` branch,
  and opens a pull request.

For safety, the action verifies the downloaded CLI's signature first, gives the
model only read access to GitHub and no web access, and does all posting and
pushing itself. Inputs, example workflows, and the security model are in
`action/README.md` in the Houston repository.

### Editor integration

`houston --acp` speaks the Agent Client Protocol (ACP) on stdio, so an editor that
supports ACP agents can run Houston without a Houston extension.

**Set it up:** point the editor's agent setting at the `houston` command with the
`--acp` argument (the desktop binary takes the same flag).

The editor's folder becomes the workspace. Its chat panel shows Houston's replies,
reasoning, tool calls (with diffs for edits), the todo list as a plan, and context
and cost as usage.

- **Modes** are the approval policies: Plan, Ask, Auto-edit, Full auto. A new session
  starts in your default policy, and the editor's mode picker switches it for the
  rest of the session, a running prompt included.
- **Approvals** appear as the editor's permission prompt: Allow (this call), Always
  allow (saves a permission rule, as in the app), Deny, or Always deny. Dismissing the
  prompt denies the call. The sandbox and your permission rules apply exactly as in
  the other clients, and file reads, writes, and commands go through Houston's own
  tools, not the editor's.
- **Plans** from Plan mode arrive as a permission prompt too: accept with edits
  applied automatically, accept approving each edit, or keep planning. Accepting
  moves the session's mode.
- **Questions** (`ask_user`) and an MCP server's input requests show as a form when
  the editor supports ACP forms. Without forms, a question is answered "use your best
  judgment" and an MCP request is declined, as in headless mode, so a run never hangs.
- **Sessions** are Houston conversations. The editor can list and reopen them, and
  they also show up in the desktop app and in `houston -i --resume <id>`. MCP servers
  the editor passes join your own for that session (as `run-acp-<name>`) and are never
  saved to your settings.
- **Credentials** resolve as in the CLI: environment variables, then saved keys. With
  no provider set up, the editor gets an "authentication required" error; an editor
  that can open a terminal is offered to run `houston -i`, which walks you through
  adding one.
- **Output and trust.** Stdout carries protocol messages only; diagnostics go to
  stderr and the log file. A folder that isn't trusted yet gets none of its project's
  allow rules, hooks, or MCP servers, as in headless mode. Trust it from the desktop
  app or `houston -i`.

## Models

Bring any model with your own key: Anthropic, OpenAI, Google, any
OpenAI-compatible endpoint, or a local model runtime.

**To add one:** open Settings, add a provider and its key, fetch its live model
list, and pick a model.

- The picker shows each model's context window and capability badges (tool calling,
  vision, reasoning).
- It warns you before you pick a model that can't call tools.
- Keys are stored encrypted by the OS keychain and never reach the app's interface.

### Each chat keeps its own settings

A chat's model, reasoning effort, and approval mode belong to that chat.

- Changing one in a chat changes that chat only. Other chats, including ones running
  at the same time, keep theirs.
- Reopening a chat (or resuming it with `/resume`) brings back the settings it was
  using.
- New chats start from the defaults, and sessions a chat starts begin with its
  settings.
- If a chat's model is no longer set up, the chat moves to another model of the same
  provider (or the default model) and says so.

**Changing the defaults:**

- **Desktop app:** the controls on the new-chat screen set the defaults, and **Use
  for new chats** in an open chat makes its settings the defaults.
- **Terminal:** add `--default` to change the default as well as the current chat:
  `/model <id> --default`, `/reasoning high --default`, `/approval ask --default`.

### When a model isn't found

If a provider answers that it doesn't serve a model (the id is mistyped, the model
was retired, or your key can't use it):

- the turn ends with a message saying so, instead of the raw error
- the model is marked "Not found" in the picker ("(not found)" in `/model`) until it
  answers a request again

Pick another model and retry.

### Claude through your cloud account

If your Claude access runs through a cloud account rather than an Anthropic API
key, add one of these from the provider picker in Settings:

- "Amazon Bedrock (AWS credentials)"
- "Google Vertex AI"
- "Microsoft Foundry"

Once added, all three behave like the Anthropic provider: the same streaming,
extended thinking, and prompt caching.

| Host | Signs in with | Region or resource | Model ids |
| --- | --- | --- | --- |
| Bedrock | your AWS credentials | region in Settings, or `AWS_REGION` | vendor prefix: `anthropic.claude-opus-4-8` |
| Vertex | Google Application Default Credentials | region in Settings, or `CLOUD_ML_REGION` | plain id, or a dated snapshot: `claude-opus-4-5@20251101` |
| Foundry | an API key from your Foundry resource | resource name in Settings, or `ANTHROPIC_FOUNDRY_RESOURCE` | plain id |

- **Bedrock** uses the standard AWS credential chain, so an `~/.aws/credentials`
  profile, an SSO login, or an instance role all work as-is. No API key needed. If
  you have an Amazon Bedrock API key instead, enter it as the optional key and it
  takes precedence over your AWS credentials. There's also a separate "Amazon Bedrock
  (API key)" provider for that case alone.
- **Vertex** needs no API key either. Run `gcloud auth application-default login` if
  you haven't already. The project is usually inferred from your credentials, so leave
  it blank unless you need a specific one.
- **Foundry** is the exception: it does take an API key. The resource name is the
  `my-resource` part of `https://my-resource.services.ai.azure.com`.

**Model lists.** The picker shows each model under one name whichever host you use.
None of the three publishes a model list, so Houston ships a curated one, and
"Fetch" restores it rather than calling out to the network. If your account can use
a model that isn't listed, add its id by hand.

### GPT models on Azure OpenAI

Add "Azure OpenAI" from the provider picker to use GPT models on your own Azure
resource. Settings needs three things:

- **API key** from your Azure OpenAI resource.
- **Endpoint**, the resource URL, such as `https://my-resource.openai.azure.com` (or
  export `AZURE_OPENAI_ENDPOINT`).
- **API version**, the `api-version` Azure serves your deployments at. Houston
  pre-fills a widely supported one. A newer model may need a newer version, which you
  can change here without waiting for a Houston update.

**Models are deployments you name yourself.** Azure has no model list to fetch, and
Houston ships none. Each model id in the provider's list is a deployment name: add
the names you created in the Azure portal, and Houston sends each request to that
deployment. One provider entry covers all your deployments.

### Dropped connections

When the provider is overloaded, rate-limiting, or drops the connection, Houston
retries the turn with a growing pause between attempts and tells you it's retrying.

- **No duplicate answers.** If part of the reply had already appeared, it's discarded
  and the turn starts over, so you only ever keep one copy. The desktop app removes
  the partial text, the terminal marks it as discarded (it can't erase what it
  printed), and headless mode never writes it to stdout.
- **Nothing half-runs.** Tool calls in a discarded reply never run.
- **Real errors stop.** A failure that isn't transient (a bad key, a malformed
  request) ends the turn instead.

### Fallback models

Name backup models for Houston to try when your selected model can't serve a turn:

- the provider is still overloaded or rate-limiting after Houston's retries
- the conversation no longer fits the model's context window, even after compacting
- the provider doesn't serve the model

Set them as an ordered list in settings.json:

```json
"fallbackModels": [
  { "providerId": "openai", "model": "gpt-5" },
  { "providerId": "ollama", "model": "qwen2.5-coder" }
]
```

- Entries are tried in order and can name any provider you've configured.
- An entry that no longer resolves (you removed the provider, or its key is missing)
  is skipped rather than failing the run.
- Any part of the reply that had already appeared is discarded before switching, so
  two models' output is never spliced together. The transcript tells you when a reply
  came from a fallback.
- A request that failed for its own reasons (a bad key, a malformed request) isn't
  retried on another model, since it would fail there too.

Leave the list unset to have a failing model simply end the turn.

## Slash commands

Type `/` in the composer for the command menu. In the terminal it appears under what
you're typing, filters as you go, and lists what each command does, including any
this project defines in `.houston/commands`.

Both clients accept the same names, so a command learned in one works in the other.

### Built-in commands

| Command | Does |
| --- | --- |
| `/new` (or `/clear`) | start a fresh conversation |
| `/compact` | summarize older turns now to free up context |
| `/retry` | run your last message again after a turn that failed |
| `/plan`, `/ask`, `/auto`, `/full` | switch the approval mode: plan, ask every time, auto-approve edits, full auto |
| `/approval` | show the current approval mode |
| `/review` | run an adversarial review of your uncommitted changes and fix what it confirms |
| `/undo`, `/redo` | revert the files the last turn changed, or put them back |
| `/rewind` | go back to an earlier message: the conversation, the code, or both |
| `/changes` (or `/diff`) | what's different in the working tree |
| `/skills`, `/agents` | list the workspace's skills and custom agents |
| `/help` | list the available commands |

Also: `/model`, `/reasoning`, `/fork`, `/btw`, `/resume`, `/cost`, `/cwd`, `/share`,
and `/doctor`. The exact set depends on the client.

**Settings commands.** `/settings`, `/login`, `/mcp`, `/hooks`, `/trust`, and
`/theme` open the matching page of Settings in the desktop app. The terminal edits a
safe subset in place. In the desktop app:

- `/settings <page>` opens that page (`/settings permissions`)
- `/settings <words>` opens Settings searching for them (`/settings proxy`)

**Desktop panels.** In the desktop app each command opens its own panel for the job:
`/changes` the Changes panel, `/model` the model picker, `/btw` the side chat.

**Terminal-only commands.** `/vim`, `/verbose`, `/output`, `/spawned`, `/proposals`,
`/image`, and `/exit`. Typed in the desktop app, they tell you where the app does the
same thing instead of being sent to the model.

### Terminal themes

`/theme` lists the terminal's palettes, and `/theme <name>` switches. Your choice is
remembered.

| Theme | For |
| --- | --- |
| `dark` | bright foregrounds for a dark background |
| `light` | readable on white (which a dark theme's bright yellow isn't) |
| `colorblind` | maps a diff's red and green to orange and blue, for the most common form of color blindness |
| `mono` | no color at all |
| `default` | the default palette |

### Custom commands

Any Markdown file at `.houston/commands/<name>.md` becomes a `/name` command.

- **Where:** in the project, or in `~/.houston/commands` for a command you want
  everywhere. A project's command wins if both define the same name.
- **Arguments:** the file body is a prompt template. `$ARGUMENTS` is replaced with
  everything typed after the command name, and `$1`, `$2`, … with the individual
  words. So `/deploy staging v2` can fill a template that says
  `deploy $1 at version $2`. With no placeholder at all, the arguments are appended.
- **Description:** optional frontmatter sets it. Without it, the first line is used
  (so existing commands keep working).

```markdown
---
description: Ship the branch to staging
---
Deploy the current branch and report what happened.
```

## The terminal composer

The interactive terminal's composer is a full line editor, so a message can be as
long as it needs to be.

- **Send:** `Enter` sends.
- **New line:** `Ctrl-J` or `Alt-Enter` adds a line break (or just paste one).
- **Pasting:** paste anything, including many lines. The whole block lands in the
  composer as one editable message and is never sent line by line. A large paste
  collapses to a short placeholder like `[#1 pasted 120 lines]` so it doesn't bury the
  screen; the real text is what gets sent. This works even in terminals without
  bracketed-paste support.
- **History:** messages are remembered per project folder and survive restarts,
  multi-line ones included.
- **Shell commands:** a line starting with `!` runs in your own shell. See "Running
  your own commands".

### Keys

| Key | Does |
| --- | --- |
| `Enter` | send the message |
| `Ctrl-J`, `Alt-Enter` | insert a line break |
| `Up` / `Down` | move between lines, then step through past messages |
| `Ctrl-R` | search past messages (type to filter, `Ctrl-R` again for older, `Enter` to accept, `Esc` to cancel) |
| `Tab` | complete a slash command or an `@`-file mention (fuzzy: `@tuied` finds `src/tui-editor.ts`) |
| `Ctrl-A` / `Ctrl-E` | start / end of line |
| `Alt-B` / `Alt-F` | move a word |
| `Ctrl-W` | delete the word before the cursor |
| `Ctrl-K` / `Ctrl-U` | delete to end / start of line |
| `Ctrl-Y` | paste back what was just deleted |
| `Ctrl-X Ctrl-E` | open the draft in `$VISUAL`/`$EDITOR` and come back with it |
| `Ctrl-L` | repaint the screen |
| `/image` | attach the image on your clipboard (also `/paste`) |
| `Ctrl-C` | discard the draft (twice in a row to leave) |
| `Esc` | *while the agent works:* clear what you typed, or stop the run if nothing is typed |
| `Ctrl-D` | leave (on an empty composer) |
| `Shift-Tab` | switch approval mode (plan → ask → auto-edit → full auto → plan) |

### Vim keys

`/vim` turns on modal editing in the composer and remembers it; `/vim off` goes back.

- Each prompt starts in insert mode, so typing a message never needs a mode change.
- `Esc` goes to normal mode.
- The marker in front of the prompt shows the mode: `I` or `N`. Terminals that
  support it also show a bar cursor for insert and a block for normal.

**Supported in normal mode:**

- **Motions:** `h j k l w W b B e E 0 ^ $ gg G`, with counts (`3w`, `d2j`)
- **Insert:** `i a I A o O s`
- **Edits:** `x X D C r`
- **Operators:** `d c y` over any motion, plus `dd cc yy`
- **Paste and undo:** `p`/`P`, `u`

**Not supported:** visual mode, text objects (`ciw`), registers beyond the unnamed
one, marks, macros, and `.` repeat.

Everything else in the composer (Enter to send, `Ctrl-R` history search,
`Ctrl-X Ctrl-E`, pasting) works the same in both modes.

## Seeing what the tools did

While a turn runs, each tool result collapses to one line: the transcript is a
conversation, not a log. To see more:

- **Failures show themselves.** A failed tool prints its first lines without you
  asking, so you can see why.
- **`/verbose`** shows each tool's full output as it runs. `/verbose off` stops it,
  and plain `/verbose` toggles.
- **`/output`** reprints the last tool result in full, after the fact. `/output 3`
  goes three results back. Nothing extra is stored for this: the whole output was
  always kept in the conversation.

Very long output is capped, with a note saying how much was left out.

## What actually ran (the receipt)

A turn that ran checks or changed files ends with a line marked **Recorded by
Houston** under the agent's last message. For example:

`No tests ran · install failed (no network) · build failed · 14 files changed`

Houston builds it from the commands it executed and the files its tools changed.
**The agent can't write it**, so it's what to check the agent's own summary against:
if the reply says the tests pass and the receipt says no tests ran, believe the
receipt.

### What it lists

- **Checks.** Commands that test, typecheck, build, lint, install, start a server, or
  send an HTTP request to a local server, each with its real exit code. For most test
  runners (pytest, vitest, jest, mocha, node:test, cargo, unittest) it also shows the
  passed and failed counts from the runner's own summary.
- **Other commands** (`ls`, `git status`) are only counted. Click the line to expand
  it.
- **Browser checks.** A page the agent looked at with `view_localhost` is listed with
  how its steps went. It counts as passed only when a check of the page
  (`expect_text` or `wait_for`) passed after the last click or keypress. Clicking
  through a flow shows it didn't break, not that it did the right thing.
- **Subagents.** Commands a writable subagent ran, each by name with its exit code and
  which subagent ran it (even an `ls`, since you didn't watch it happen), and files a
  subagent changed, marked with who changed them.
- **Your verify command**, when Houston runs it at the end of a turn.
- **Background commands:** how one ended, or that it's still running (for a dev
  server).
- **Stale checks.** A check that ran before the turn's last file change says so, since
  it may not cover the final code.

### Todo items it can't back

When the agent marks a todo done that says a check ran ("Backend tests with pytest",
"Verify the build") and no passing run of that check is recorded this turn:

- the receipt lists it as marked done with nothing recorded
- the agent is told at the moment it marks it
- the todo list itself stays as the agent wrote it

Items about writing something ("Write tests for the API") never need a run behind
them.

### An accepted plan's progress

After you accept a plan, each turn that works on it shows how far along it is,
counting every turn since you accepted it. For example: "plan: 9 of 11 files, 1 of 3
checks passed".

- It lists the files the plan named that nothing has changed yet, and each of its
  checks: passed, ran with nothing passing, or not run yet.
- It holds across turns, so "finish the planned implementation" two turns later picks
  up where it was.
- It says "plan complete" once, and stops when a newer plan replaces it or the chat
  moves on to other work.
- If you ask to skip the checks, they show as skipped.

### Outcomes it can't tell

These show as unknown rather than passed:

- an HTTP request made without `curl -f` (so an error page still exits 0)
- a test whose exit code is hidden by what follows it (`pytest | tail`,
  `pytest; echo done`)
- a page that loaded with nothing on it checked

### Where it lives

- It's saved with the conversation and shown again when you reopen it.
- It never goes to the model.
- Importing a conversation doesn't bring receipts along, since Houston didn't record
  those runs.
- The terminal client and headless mode print it too, `--json` includes it in the
  result line, and an HTML export shows it under the turn.
- **It costs nothing:** no extra model calls and no extra commands. It only reads
  what already ran.

## Diagrams and visuals in replies

In the desktop app, the agent can answer with pictures as well as text. In the
terminal these blocks stay code, with a line pointing at the desktop app.

### Diagrams and images

- A ` ```mermaid ` block (a flowchart, sequence, state, or entity diagram) is drawn as
  a diagram.
- An ` ```svg ` block is drawn as an image.
- Each has a Rendered/Code switch, so the source is always one click away.
- Diagrams follow the app's light or dark theme. One that doesn't parse shows the
  error above its source.
- **Safe by design:** Mermaid runs in a separate hidden window that can't reach the
  network, never in the app itself, and the result is shown as an image, so nothing
  in it can run.

### Interactive visuals

Off by default. Turn on **Run interactive visuals in the chat** in Settings
(Appearance) to let an ` ```html visual ` block run, such as a small chart with
controls or a widget to try.

- It runs in a sandboxed frame with no access to the app, no network, and no forms,
  popups, or navigation.
- It has its own process, so a misbehaving one can't freeze the chat.
- With the setting on, plain ` ```html ` blocks also get a Preview button.
- At most three run at once; the rest wait behind a Run button.

## Editing files while it works

You can keep working in your own editor while a turn runs. Your changes are never
overwritten by an older copy.

**Before the agent overwrites or edits a file, Houston checks two things:**

1. the agent has read the file in this conversation
2. the file still says what the agent last saw

If you changed it in the meantime (or a shell command, a formatter, or a subagent
did), the write is refused and the agent reads the file again first.

- Creating a new file needs no read.
- Reads carry over between messages of one conversation for files nobody has changed
  since. After the app restarts, or once a read has been compacted out of the
  conversation, the agent reads a file again before changing it.
- Changes Houston makes on the agent's behalf right after a write (format-on-save, a
  PostToolUse hook) don't count as yours.

**Precise edits.** The agent sees files with line numbers, so it can cite exact lines
and page through a large file by them.

- When an edit lands somewhere the agent didn't spell out exactly (its snippet had
  drifted from the file, or carried copied line numbers), the result shows the edited
  lines so it can check them.
- An edit whose snippet matches nothing points the agent at the closest part of the
  file instead of only failing.

## Code intelligence (language servers)

When a language server for the project's language is installed, Houston uses it the
way an editor would: to check the agent's edits, and to give the agent type-aware
navigation. It's on by default whenever a server is installed.

### Checking edits

After the agent writes a file a server covers, the tool result lists the errors the
edit introduced (and up to five new warnings), so the agent can fix them in the same
turn.

- Problems the file already had before the edit are left out.
- A clean edit adds nothing.
- The first check in a conversation starts the server (a large project can take
  several seconds to load). After that, files the agent reads are opened in the
  running server in the background, so later checks are usually quick.

**Diagnostics on save** (Settings > **Tools**) picks what runs after an edit:

- the language server, when one covers the file (the default)
- the language server, or else a fast checker (`eslint`, `ruff`/`pyflakes`, `gofmt`)
  for other files
- no check at all

### Navigation tools

These are offered only when a server is installed for a language the project uses,
so a project without one pays nothing for them.

| Tool | Gives the agent |
| --- | --- |
| `lsp_definition` | where a symbol is defined (following imports through to the declaration) |
| `lsp_references` | every real use of a symbol across the project |
| `lsp_hover` | a symbol's type, signature, and documentation |
| `lsp_document_symbols` | a file's outline |
| `lsp_workspace_symbols` | symbols by name across the project |
| `lsp_rename` | renames a symbol everywhere it's used |

- **Read-only and fast.** All but `lsp_rename` are read-only, need no approval, and
  run in parallel with other reads.
- **Contained.** Results never include files outside the project, and lines from
  credential files aren't quoted.
- **Renames are ordinary patches.** The server's edits are applied as one
  `apply_patch`, so a rename asks for approval like any patch (with a diff of every
  file), follows your `apply_patch` permission rules file by file, and is undone by
  **Revert** like any other change. A rename that would touch a file outside the
  project, or create, move, or delete files, is refused.

### Supported servers

None are bundled; install the ones you want.

| Language | Server |
| --- | --- |
| TypeScript, JavaScript | `typescript-language-server` or `vtsls` (a copy in the project's `node_modules/.bin` is preferred over one on `PATH`) |
| Python | `pyright-langserver` (from `pyright`) or `basedpyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` |
| C, C++ | `clangd` |

**Adding others.** In Settings > **Tools** > **Language servers**, add a JSON list of
`{ "id", "command", "extensions" }` entries (plus optional `args`, `languageId`,
`rootMarkers`). Reusing a built-in id (`typescript`, `python`, `go`, `rust`,
`clangd`) replaces it.

**What's installed:** Settings > Tools > **Optional integrations** and `/doctor` both
show it.

### How servers run

- They start on demand, one per language and project, are reused across turns, and
  stop after ten idle minutes or when Houston quits.
- They run in the same sandbox as shell commands, with no network.
- A server can run code from the project (a TypeScript plugin named in
  `tsconfig.json`, a Rust build script). So on a host where the sandbox can't confine
  it, servers stay off unless you set **Run language servers** to **Always**.
  **Never** turns them off everywhere.
- Setting `HOUSTON_LSP=off` in the environment also turns them off for that process.

## Typing while it works (steering)

You don't have to wait for a turn to finish before saying the next thing. Type while
the agent works, press `Enter`, and your message goes to the turn that's running.

**Why it helps.** The agent reads your message before its next step, so "no, use YAML
instead" changes what happens next rather than arriving after the work is done. It's
the middle ground between two bad options: interrupting throws away the turn's work
and its context, and waiting lets the agent keep building on the wrong thing.

- **Honest timing.** Houston prints `· steering: …` at the moment the message actually
  reaches the model, not when you pressed `Enter`. Until then it has changed nothing.
- **Part of the conversation.** A steered message appears in the transcript and is
  remembered like anything else you said.

### In the desktop app

- `Enter` steers the running turn.
- `⌘+Enter` (`Ctrl+Enter` on Windows and Linux) **queues** the message instead, to be
  sent as the next turn when this one finishes.
- While a run is going, the message box says so, and the **Steer** button sits where
  Send normally is, with **Queue** beside it.
- A steered message is labelled **Steered** in the transcript.
- Until it reaches the model, it waits as a chip above the message box, marked with
  the steer icon. Its × takes it back.

### Special cases

- **The agent asked you something.** While it waits on a question, `Enter` answers the
  question instead (the box says so), since the agent can't read anything else until
  it has your answer.
- **Long messages.** A message longer than a steer allows (2,000 characters) is queued
  for after the run instead of being cut.
- **Commands.** A `/command` or a `# rule` typed mid-run is run or saved, never sent to
  the model as text. In the terminal it runs once the turn ends. In the desktop app it
  runs right away (switching the approval mode applies to the running turn), except
  `/compact`, which waits until the turn ends.

### Your message is never dropped

- **The turn finished first** (you typed as the agent was wrapping up): the message is
  sent as the next one automatically, with no second `Enter`. Several such messages go
  together as one.
- **The turn ended another way** (you pressed Stop, the provider failed after its
  retries, the turn hit its step limit): the message stays as a queued chip to send or
  clear.
- **Restarts:** queued messages are saved with the chat, so quitting or restarting
  Houston keeps them.
- **Terminal interrupts:** a message typed before you interrupt a turn is put back in
  the prompt for you to edit or send.

### Stopping

- `Esc` clears what you've typed. On an empty line, `Esc` stops the run (so does
  `Ctrl-C`).
- Stopping a run also drops anything still waiting, since those messages were
  follow-ups to work you just threw away.

## How long a turn runs

A turn has a **step budget**: 40 by default, where each model reply is one step. Near
the end, the agent is told to wrap up. It finishes the edit in hand or summarizes
what's left instead of being cut off, and you say "continue" to pick it up.

### Productive turns keep going

A turn that's plainly making progress gets another round of steps instead of the
wrap-up, and the transcript says so. It counts as productive when, among its recent
steps, either:

- several edited files successfully, or
- most turned up something new (a file it hadn't read, a search or command it hadn't
  run)

and it hasn't been caught looping. Going back over calls it already made doesn't
count.

This continues up to a **hard limit** (200 steps by default), so a big job such as
scaffolding a new project, or a long debugging session, finishes in one go. Stopping
the run works as usual at any point.

**Settings:** Settings > Agent Behavior > Loop control has the per-turn step count,
the keep-going-while-productive switch, and the hard limit. If you had already set
your own step count, it stays a hard stop until you turn the switch on.

### Long replies

A single reply also has an output limit.

- When a reply is cut off there, the agent picks it up exactly where it stopped (up to
  three times in a row) instead of leaving a half-finished answer. The transcript
  notes each time.
- A tool call the limit cut off is never run on partial input. It's answered as "not
  run", and the agent redoes the work in smaller pieces.
- Either way, later replies in the turn ask for the model's full output allowance
  where Houston knows it.

## Undoing a turn, and seeing what changed

| Command | Does |
| --- | --- |
| `/undo` | puts back the files the last turn changed |
| `/redo` | re-applies them |
| `/changes` (or `/diff`) | summarizes everything different in the working tree: each file with its status and lines gained and lost, plus a total |

- **Nothing to set up.** Houston snapshots every write before it happens.
- **Best with auto-approve modes**, where edits land without a prompt: "that was
  wrong, put it back" is one word rather than a hand revert.
- **Limits.** `/undo` covers the last turn's file writes only. It doesn't undo shell
  commands, and it doesn't touch git history.
- `/changes` is the natural question after a long autonomous run.

### Shipping changes (desktop app)

When the working tree has changes, the bar above the composer and the Changes panel
offer one button that fits the repository:

| Button | When |
| --- | --- |
| **Create PR** | it has commits and a GitHub remote (github.com, or a GitHub Enterprise host your `gh` is signed in to) |
| **Publish to GitHub** | it has no remote yet (commit, create the repository, push) |
| **Push first commit** | a remote exists but nothing is committed |
| **Commit & push** | the remote isn't on GitHub |

Each one hands the work to the agent as a normal turn, so every git and network step
goes through your approvals.

### Prompts Houston writes for you

`/review`, `/agent`, the shipping buttons, and a session another chat handed off
each send the agent a detailed prompt. The chat shows what you did (for example
"/review" or "Create PR") instead of that prompt. Open **Instructions sent to the
agent** under it to read the exact text. The terminal prints a one-line summary in
its place.

## Rewinding to an earlier message

Rewind takes a chat back to just before one of your earlier messages. You choose what
goes back:

| Choice | Messages | Files |
| --- | --- | --- |
| **Conversation and code** (default) | removes that message and everything after it | puts back the files the agent changed from that turn on |
| **Conversation only** | removed | stay as they are |
| **Code only** | the chat stays | put back |

### In the desktop app

- Hover one of your messages and click the rewind button for these choices.
- Or press `Esc` twice in an empty composer (or type `/rewind`) to pick the message
  from a list.
- A confirmation shows how many messages and files are affected before anything
  changes.
- After a conversation rewind, the message you rewound to is back in the composer to
  send again or change.
- **Edit and resend** (same menu) puts a message in the composer for editing. Sending
  it rewinds to that message first (conversation and code by default, or conversation
  only), then sends the new text, so the agent re-runs from there.

### In the terminal

`/rewind` lists your messages by number, asks which one and what to rewind, shows the
same summary, and asks you to confirm.

`/rewind 3 code` skips the questions for message 3. The modes are `both`,
`conversation`, and `code`.

### Things to know

- **Your edits are safe.** A file is put back only while it still holds what the agent
  wrote. A file you (or anything else) changed since is left as it is and listed.
- **Created and deleted files.** Files the rewound turns created are deleted, and
  files they deleted come back.
- **Shell commands aren't snapshotted.** A rewind can't undo what `run_shell` did:
  installed packages, generated files, git commits, deleted files.
- **Undo a rewind** with **Undo rewind** (desktop) or `/rewind undo` (terminal). It
  reverses the latest rewind, messages and files both, until you send another
  message.
- **Not mid-turn.** Rewind is unavailable while a turn is running; stop it first.
- **History depth.** Houston keeps snapshots for the most recent 200 turns across all
  chats. A turn older than that can't have its files put back, and the confirmation
  says so.

## Being told when it needs you

A long run can stop on an approval, a question, or a plan, and then it's just
waiting. The interactive terminal tells you, two ways:

- **The tab title** always shows the state: what it's doing, that it needs approval,
  or that it's idle, with the project name so you can tell sessions apart. It's
  ambient, never interruptive.
- **A bell and a notification** fire when a run needs you or finishes, but only when
  you've switched away from the terminal. (Houston asks the terminal to report focus.
  If your terminal doesn't, they fire either way rather than staying silent.)

**What rings:** needing approval, needing an answer, a plan awaiting a verdict, an
error, a finished turn, and a pull request opened or merged. Ordinary progress is
quiet, and stopping a run yourself never pings you (you're obviously there).

- Turning off notifications in Settings turns off the bell and notification here too.
  The title still updates.
- Notifications use the terminal's own channel, so they need no extra tools. Not every
  terminal supports them; the bell works everywhere.

## How hard the model thinks (/reasoning)

| Command | Does |
| --- | --- |
| `/reasoning` | shows the current chat's thinking effort |
| `/reasoning high` (or `off`, `low`, `medium`, `xhigh`) | sets it for this chat |
| `/reasoning high --default` | also makes it the default for new chats |

- **Default: `high`**, since coding and long multi-step work gain the most from deeper
  thinking.
- **Turn it down** (`medium`, `low`, or `off`) for quick questions or to save money.
  More thinking costs more tokens and takes longer per step.
- **Every reasoning model.** It applies to every model that supports reasoning. When
  the model you're on doesn't, Houston says so plainly, since a setting that silently
  does nothing looks like a bug.
- **Desktop app:** the same setting is in the reasoning menu next to the model picker.
  Changing it while the agent works applies from its next step.

## What a session cost (/cost)

`/cost` breaks the session down by model:

- tokens in and out
- how many input tokens were served from the prompt cache
- the dollar cost, with a total when more than one model billed

Subagents and reviews often run on a different (cheaper) model, so they're listed
separately rather than folded into the main one. In the desktop app, the breakdown
also lists what each subagent spent (already counted in its model's row).

**Watch the cached count** on a long session. Those tokens are real context, but they
bill far below the base input rate, so a big number there is why a long conversation
costs less than its token count suggests.

## Version and updates

- **See your version:** the interactive terminal shows it in the startup banner, and
  `houston -v` prints it.
- **Update notices:** once a day, Houston quietly checks for a newer release. If there
  is one, it prints a short notice the next time it draws a prompt, with the command
  that upgrades this copy, such as `brew update && brew upgrade houston`,
  `npm i -g @houston-code/cli@latest`, or re-running the install script (or the
  download link when it can't tell how Houston was installed).
- **One-shot runs:** a `-p` run prints the same notice on stderr after its answer, only
  when stderr is a terminal, and never in CI or with `--json`.
- **Never in the way:** the check never blocks startup or delays a run. A failed check
  (offline, timed out, rate limited) is silent, keeps the last known result, and is
  retried after an hour.
- **Turn it off:** set `HOUSTON_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER`).

The desktop app updates itself separately.

## Checking your setup (/doctor)

`/doctor` reports what Houston can see, in both the desktop app and the terminal:

- the version, and whether a newer one is out
- Node and the platform
- the active model and every provider's key status
- whether the shell sandbox is actually enforced on this host
- which external tools (`git`, `gh`, `rg`) are on `PATH`
- which language servers are installed, and whether servers are off on this host
- each MCP server's connection state
- in the terminal, the terminal's size and color support

Each row is marked healthy, worth knowing, or broken, and anything not healthy comes
with what to do about it.

**Questions it answers:** "is my shell really sandboxed here?" and "why did setting my
API key change nothing?" (an environment variable silently outranks a stored key, and
`/doctor` names it).

## Running your own commands (!)

Type `!` and a command to run it in your own shell without leaving the session:
`!git status`, `!npm test`. Output streams as it happens.

- **The agent sees it too.** What you ran and what it printed is added to the
  conversation, so you can follow up with "now fix those failures" with nothing to
  paste back. Long output is trimmed to its last lines, where errors usually are.
- **It's your shell, not the agent's.** It runs unsandboxed, in your project folder,
  with your environment, exactly as if you'd typed it in another window. The sandbox
  exists to confine the agent, which can be steered by instructions hidden in what it
  reads; a command you typed yourself is your own decision.
- `!` alone, or `!` in the middle of a line, is ordinary text.

## Approval modes and permissions

Approval is layered: a mode for the chat, permission rules that refine it, and
guardrails that projects and administrators can add.

### The four modes

From most to least restrictive:

| Mode | Edits | Shell commands |
| --- | --- | --- |
| **Plan mode** | blocked | blocked (read-only research) |
| **Ask every time** | ask | ask |
| **Auto-approve edits** | automatic | ask |
| **Full auto** | automatic | automatic (sandboxed), with the guardrails below |

### Plan mode

The agent researches and proposes a plan; writes and shell commands are blocked. You
accept the plan, request changes, or reject it.

- **Checks it can run.** The plan lists the checks it will run, and under them Houston
  shows whether they can run on this machine: whether the runtimes and dependencies
  are installed, and whether shell commands can reach the network to install them
  (for example, "choose Allow for run on the install command").
- Houston works this out from the machine without running anything, and tells the
  agent about any problem when you accept, so it can say a check couldn't run instead
  of claiming it did.
- **Switching is immediate.** Turning Plan mode on or off takes effect at once, even
  mid-turn, and Houston tells the agent before its next step.

### Guardrails in full auto

The sandbox can read your whole filesystem, so a few controls hold even in full auto:

- **Network, per destination.** Approving a fetch to one host doesn't open egress to
  another. See "Network calls in full auto" below.
- **Shell commands start offline.** The first time one fails for lack of network,
  Houston asks once whether shell commands in this chat may reach the network (the
  **shell-network consent**). Declining keeps them offline. When you allow it, the
  agent retries the command if that's safe. Blanket outbound access is never
  automatic.
- **Paths outside the project.** A shell command that names one, quoted or not, asks
  first. `/dev/null` and the temp directory the sandbox can already write to don't
  count.
- **Reading a credential file** (a `.env`, a private key, `.aws/credentials`, and the
  like) asks, even though reads otherwise never do. "Allow for run" on that prompt
  stops it asking about credential reads for the rest of the conversation, and an
  `allow` permission rule opts a path in permanently.
- **Changing a credential file** asks too: a file edit that writes one, or a shell
  command that redirects into, copies over, edits in place, or removes one
  (`> .env`, `cp .env.example .env`, `sed -i … .env`, `rm .env`). Templates such as
  `.env.example` don't count.

### Network calls in full auto

GitHub reads run without asking: `gh_pr_list`, `gh_pr_view`, `gh_pr_checks`,
`gh_issue_list`, `gh_issue_view`, `gh_run_list`, `gh_run_view`.

Everything else asks once per destination, and "Allow for run" covers only that
destination (the prompt says which):

- **`web_fetch`** asks once per site, and **`web_search`** once per chat. Settings →
  Permissions → **Web reads in full auto** can let these run without asking. Either
  way, a URL or query carrying a credential is refused.
- **`view_localhost`** asks once per host, since a page can load from the internet. A
  call that clicks or types (`steps`) asks once more per host.
- **GitHub writes** (open a PR or issue, comment, review, reopen, mark ready or draft)
  share one grant per repository, so allowing a comment on one repository never allows
  anything on another. The repository is the one `gh` would pick (your
  `gh repo set-default` choice included), and every call is told to use exactly that
  one, so pointing the remotes or the default repository elsewhere asks again.
- **Merging a PR, closing a PR or issue, checking out a PR, and creating a repository**
  each ask on their own: allowing a comment never allows a merge.

### Throwing away work always asks

These ask in every mode, full auto included. The sandbox keeps commands inside the
project, but the project is exactly what these destroy, and undo doesn't cover shell
commands.

- `git reset --hard`, a forced `git clean`, `git checkout -- .`, or `git restore` of
  your changes
- `rm -r` of anything but build output and dependencies (`node_modules`, `dist`,
  `build`, `target`, `__pycache__`, and the like are fine)
- `find … -delete`
- deleting a branch or a stash, rewriting history
- a forced or deleting `git push`

Quoting a word, splitting it across lines, or running it through `bash -c` doesn't
hide one. "Allow for run" doesn't stop these asking; an `allow` permission rule for
that exact command does (the "Always allow" choice on the prompt saves one).

### Which mode a new install starts in

- **Full auto** where the sandbox confines shell commands: macOS, and Linux with
  bubblewrap.
- **Ask every time** where it can't (Windows, or Linux without bubblewrap), since
  every command would run unconfined.

An existing install keeps the mode it last used. The desktop app and the terminal
start in the same saved mode. `--approval` or `--full-auto` overrides it for one
terminal session, and a headless run starts in plan unless told otherwise.

### Approving a call

On any single tool call you can:

- **approve once**
- **deny**
- **allow for the run:** auto-approve that kind of tool for the rest of the
  conversation (for a network call, just that one destination, which the prompt
  names)
- **always allow / always deny:** save a permission rule so the choice persists

**Reading the diff.** A file edit shows a real diff before you approve it: the changed
part with a few lines of context (long untouched stretches are folded away with a
note saying how many), line numbers in the gutter, the changed words picked out inside
a modified line, and syntax colouring.

**Denying with a reason.** A refusal can carry guidance, and the agent is told what it
says, so "no, and here's what to do instead" lands in the same step.

- **Desktop app:** type it in the box under the approval buttons. `Enter` denies with
  that reason.
- **Terminal:** pick "Deny with a reason…", or just type the reason at the approval
  prompt. Anything that isn't a shortcut key is read as a denial plus that
  explanation.

**Terminal approval keys:** `y` allow, `n` deny, `a` allow for the run, `!` always
allow, `x` always deny.

Stopping a run while an approval is waiting is recorded as an interruption, not a
refusal, so the agent isn't told you rejected something you never answered.

### Switching mode

- **Terminal:** `Shift-Tab` steps through the modes, from most restrictive to least and
  back around to plan. `/approval <mode>` sets one directly.
- **Works mid-turn.** It applies to the run in progress: if a turn stops for an
  approval you'd rather not keep answering, loosen the mode and the same turn carries
  on under it.
- **Where it's shown:** next to the spinner while a turn runs, and on the status line
  above the composer the rest of the time.
- **Per chat.** The mode belongs to the chat, like its model (see "Each chat keeps its
  own settings"). New chats start in the mode chosen in Settings > **Permissions** >
  **Approval mode**.

### Permission rules

Rules (in Settings) are finer-grained than the mode: `allow`, `deny`, or `ask`,
matched on the tool plus a glob over its target. For example:

- allow `run_shell` matching `git *`
- deny anything matching `*rm -rf*`
- always ask before `write_file` under `src/secret/**`

**Order matters.** Rules are checked before the mode, and the first match wins.
Settings lists them numbered in the order they're checked; drag a rule or use its
arrows to move it. **By tool** groups the list per tool instead.

**Settings flags problems:** a rule that can never apply because an earlier one already
matches everything it would (a `*` pattern for the same tool, or the same pattern), an
empty pattern (it matches nothing), and an allow of `*`.

**History.** Each rule notes when it was added (and whether from an approval prompt or
by hand) and when it last decided a call, which helps you prune rules you no longer
need.

**Test a call** takes a tool and a command, path, URL, or query, and shows what the
rules decide and which rule decides it. It uses your unsaved edits and the
administrator and project rules. It covers rules only, so a write outside the project
or to a sensitive file can still ask.

**Edit as text** shows the rules as JSON, one per line, in the same shape as
`permissionRules` in settings.json, for bulk edits or moving rules between machines.
It checks the text as you type (a misspelt field is an error, not ignored), flags
rules that could never apply, says what applying would add, remove, or reorder, and
keeps each surviving rule's history.

#### Rules can't be dodged by respelling

Matching normalizes the target first:

- **File rules** are resolved and anchored to the workspace. `src/*` covers the same
  file written as an absolute path, and a climb like `src/../../etc/passwd` doesn't
  slip past it.
- **URL rules** are case-insensitive on scheme and host.
- **Shell rules** see through quoting, backslash escapes, and bash's `$'...'` escapes,
  so `deny *rm -rf*` still fires on `"rm" -rf`, `r\m -rf`, or `$'\x72m' -rf`.
- **Line continuations.** A line ending in a backslash continues onto the next, as in
  bash, so a deny fires on `rm` split across two lines, and an allow must cover the
  joined command.

**Allow rules only see through quoting where it changes nothing.** `"git" status` is
`git status`, but a quoted or escaped `*`, `~`, `$`, space, or `>` isn't the bare one,
since the shell treats them differently:

- allowing `rm '*'` (one file named `*`) never allows `rm *`
- allowing `rm -rf '~'` (or `rm -rf $'\x7e'`) never allows `rm -rf ~`
- an empty quoted argument counts as one: allowing `'' rm -rf /` (which runs nothing)
  never allows `rm -rf /`
- quoted or escaped whitespace is part of an argument, as in bash: allowing
  `rm 'my  file'` (two spaces) never allows `rm 'my file'`, and allowing
  `find . -delete \ ` (find gets a lone space and stops) never allows `find . -delete`

Spacing outside quotes doesn't matter. A rule an earlier version of Houston saved with
that whitespace collapsed allows what its text says. One that ends in a lone backslash
matches nothing, and **Clean up rules** removes it.

#### Patches

An `apply_patch` call is checked against every file it adds, changes, deletes, or
moves to:

- one denied file denies the whole patch
- one `ask` file asks
- an `allow` covers it only when every file is allowed

"Always allow" or "Always deny" on a patch saves one rule per file.

#### Exact rules and what "Always allow" saves

A rule marked **Exact** matches only its one target: `*` is an ordinary character,
and a folder doesn't cover the files inside it.

| "Always allow" on | Saves |
| --- | --- |
| a file | an exact rule, so approving a write to a file named `*`, or to a folder path, allows that path and nothing else |
| a `web_fetch` | the site (`https://example.com`, covering every page there) |
| a `web_search` | every search |
| a shell command | a command prefix, such as `npm install` |

- A shell command it can't shorten to a prefix is saved whole, and exact when it holds
  `*`, so approving `rm *` never allows `rm -rf ~`.
- A `cd` into the project needs no rule (an allowed `npm install` also covers
  `cd src && npm install`), so it's left out. Any other change of directory, such as
  `cd -`, `popd`, `cd $DIR`, or a `cd` out of the project, still asks, and is saved
  whole and exact.
- A shell rule like `rm *` saved by an earlier version is still a pattern. Tick
  **Exact** on it to narrow it.
- **Always deny** saves a regular pattern, which can only be broader than the call it
  blocked.

### Project guardrails

A repo can ship a `.houston/settings.json` with its own `deny` / `ask` rules, checked
before your global rules. They always apply and can only *tighten*, so cloning an
untrusted repo can never auto-approve anything.

### Trusted folders

The same project file can also define `allow` rules, `hooks`, and `mcpServers`. Those
*elevate* (they auto-approve matching actions or run processes as you), so Houston
ignores them until you explicitly trust the folder.

- **How you're asked:** the desktop app shows a banner above the composer, and the
  interactive terminal asks at session start (Trust / Not now / Never).
- **Re-asked on change.** Your decision is bound to a fingerprint of that elevating
  config. If it changes (say a pull adds a hook), the folder drops back to untrusted
  and Houston asks again.
- **Headless runs** never prompt; they note when an untrusted folder's extra config is
  being ignored.
- **Once trusted:** project `allow` rules sit *below* your own rules (they fill gaps,
  never override you), project hooks run after yours, and project MCP servers appear
  namespaced as `mcp__proj-<id>__<tool>`.

**Reviewing decisions.** Settings > *Permissions* > *Trusted folders* lists every
folder you answered for (trusted or never), with a Forget button. In the terminal,
`/trust` shows the current folder's state, and `/trust forget` clears the decision and
asks again on the spot. Forgetting is how you reverse a "Never" or retire a stale
"Trust".

### Managed policy

On a managed device, an administrator can ship a machine-wide `managed-settings.json`
with `deny` / `ask` rules that outrank both project guardrails and every user's own
rules. It too can only tighten, and it lives in a root-owned location the user can't
edit.

### How the tiers stack

Settings > Permissions > **All sources** lists every tier in the order it's checked:

1. the administrator's policy
2. the open project's guardrails
3. your own rules
4. the project's allow rules (with whether they're in effect)
5. the chat's approval mode

The project's hooks and MCP servers show read-only on the Hooks and MCP Servers pages;
edit them in `.houston/settings.json`.

## Skills

A skill is a reusable bundle of instructions the agent loads only when a task needs
it.

**Create one** at `.houston/skills/<name>/SKILL.md`, with frontmatter `name` and
`description`, and a body of instructions.

**How it's loaded (progressive disclosure):**

1. The agent sees only each skill's name and description up front, which is cheap.
2. When a task matches, it loads the full body by calling the `skill` tool.
3. Any other files in the skill's folder (a `references/` folder, a template, a helper
   script) are listed at the end of the `skill` response. The agent reads or runs them
   with the file tools when the instructions say to, and only when a task needs them.

**Built-in skills:**

- `houston-guide`: this guide.
- `render-ui` (desktop app): what the agent follows when you ask to see how something
  looks or will look, using screenshots of the running app or a mockup, shown with
  `show_images`.

## Custom subagents

A subagent works on a task in its own fresh context and reports back, keeping the
main conversation clean.

**Define one** with a Markdown file at `.houston/agents/<name>.md`: frontmatter
`description` plus a system-prompt body. The main agent dispatches it by name with
`dispatch_agent`.

### Frontmatter options

| Key | Effect |
| --- | --- |
| `description` | what the agent is for (required) |
| `tools:` | narrows which tools it may use |
| `model:` | pins it to a (usually cheaper) sibling model from the current provider; unknown ids fall back to the chat's model |
| `max_turns:` | a hard limit on its steps (a whole number up to 500) that never extends |
| `write: true` | gives it the writable tier (see below) |

### Read-only and writable

- **Read-only by default.** A subagent can't edit files or run commands.
- **Writable** (`write: true`) subagents are dispatched with `dispatch_writable_agent`,
  which asks for approval because it grants write access. One approval covers the
  whole delegated task's local actions, confined to the project.

### Permissions still apply

Inside either tier, your permission rules work exactly as for the main agent:

- a `deny` rule (including a managed-policy or project guardrail one) refuses the
  subagent's call outright
- an `ask` rule, a credential-file read (a `.env`, a private key), or a shell command
  naming a path outside the project asks you first

**Network.** Either tier can use `web_fetch` and `web_search`, and every network
request asks you for approval per destination, like the main agent's own calls. A
denial comes back to the subagent as its tool result. A subagent's shell commands
never get network access.

**Unsandboxed hosts.** On a host without an OS-enforced sandbox (such as Windows),
each shell command a writable subagent runs would run unconfined, so each asks for its
own approval too.

**Cost.** Tokens a subagent spends roll into the conversation's usage meter, priced
at the model it actually ran on.

### Seeing what a subagent did

**While it works,** its row in the desktop app lists each step as it happens (what it
read, searched, edited, or ran, with the outcome: lines read, matches found, a
command's exit code, an edit's line counts) and shows its model, step count, time,
and tokens. A nested agent gets its own indented block.

**When it finishes,** the row collapses to a summary: model, steps, time, cost, and
its id (like `ag1`). Expand it for three tabs:

- **Report:** the agent's report, rendered.
- **Steps:** each step expands to its result, or an edit's real diff.
- **Prompt & setup:** the exact task the main agent wrote, which agent and model ran
  it and who chose the model, its tools, step budget, usage, and system prompt.

**Open transcript** shows the whole run in order in a side panel, with a Copy as
Markdown button. A review's row links to the same view for each of its reviewers.

**Saved with the chat,** so it's there after a restart. Settings > Agent Behavior >
Loop control sets how much a chat keeps (4 MB by default). Past that, the oldest
subagents keep their task, steps, and report but drop step results and diffs.

**In the terminal,** a line is printed per step under the dispatch (a review's
reviewers only with `/verbose`), then the report. `--json` emits `subagent_start`,
`subagent_step`, and `subagent_end`.

### Step budget

A subagent works under the same step budget as the main agent:

- the "Steps per turn" setting, extended in the same chunks while it's still finding
  things out or making edits, up to the same hard limit, with the same loop detection
- near the end it's told to wrap up, and its last step can't run tools, so it always
  ends with a report of what it has
- a custom agent's `max_turns` replaces all of this with a fixed limit
- a review's agents keep the base budget without extending, since a review runs many
  at once

### Follow-ups and nesting

- **Resume.** The main agent can pass a subagent's id back as `resume` to send a
  follow-up into that subagent's context instead of starting over. Ids last for the
  app session; the saved record doesn't make an agent resumable after a restart.
- **Cheaper legwork.** A dispatch can pass `model` to run one-off work on a cheaper
  sibling model.
- **One level of nesting.** A dispatched agent may dispatch its own nested read-only
  researchers (never writable, and no deeper).

### Running one yourself

`/agent <name> <task>` hands a job to one of your agents directly, instead of
describing it and hoping the right one gets picked. It works in the desktop app and
the terminal. `/agent` alone (or `/agents`) lists them.

## Spawn separate sessions

A subagent reports back into the current turn. `spawn_session` instead spins off a
*separate* chat that runs in the background.

- **What it gets:** the agent hands it a task, optionally on its own git branch and
  worktree. It starts fresh with its prompt or, with context "fork", with a copy of
  the spawning chat so far.
- **Never more permissive.** It inherits the current approval policy.
- **When it finishes,** the chat that started it gets a short report (title, whether
  it worked, the start of its answer) as a Houston note at the start of its next turn,
  and you see a notice in the transcript.

### In the desktop app

- It appears in the sidebar with a live indicator, under the chat that started it,
  seeded with the handed-off context.
- The arrow beside the parent folds them away. A folded parent shows the most urgent
  state among them, such as "1 needs input" or "2 running", and Houston remembers what
  you folded across restarts.
- A session you pin or move into a group stays where you put it.
- Its "Handoff from …" banner links back to the parent chat.

### In the terminal and headless

Spawned sessions run here too:

- they run non-interactively, and anything needing an approval is declined
  automatically
- they're saved as ordinary conversations you can open later with `/resume` or
  `--resume <id>`
- a one-shot headless run waits for its spawned sessions before exiting

## Proposed sessions

When the agent spots parallel work you didn't ask for (a fix noticed in passing, the
natural follow-up), it *proposes* it with `propose_session` instead of starting it.
Nothing runs until you choose.

**In the desktop app,** a card offers:

- **Start session:** runs it as its own chat, on its own git worktree when the project
  is a repository, under your current approval policy.
- **Do it here:** asks for it in this chat instead (queued if a turn is running).
- **Dismiss:** declines it.

**In the terminal,** `/proposals` lists the chat's proposals, and
`/proposals start <n>`, `/proposals here <n>`, and `/proposals dismiss <n>` act on
one.

**Limits:** a turn can propose at most three sessions, and never the same title twice
in one chat.

## Side chat (/btw)

The side chat answers a quick question about the open chat without adding anything
to it.

- **Open it** from the titlebar (or the command palette). In the terminal,
  `/btw <question>` asks the same side chat (shared with the desktop panel), and
  `/btw clear` starts it over.
- **What it can do:** it sees the chat so far and can read the project, but it can't
  edit files, run commands, or reach the network.
- **Works mid-turn.** You can use it while the main chat's turn is still running.
- **Cost:** its tokens count toward the chat's cost.

**Moving an answer over:**

- **Send to main** puts an exchange into the main chat as a message (queued if a turn
  is running).
- **Continue in new chat** forks the chat with the exchange as a draft.

**It keeps its place.** Each chat has one side chat, kept with the chat. Closing the
panel, switching chats, a plan review taking over the panel, or restarting Houston
never loses it, and an answer still coming in keeps going and shows up when you come
back. Before each follow-up it catches up on what the main chat said since its last
answer. **New side chat** (the + in its header) clears it and starts over.

## Watching work you sent off (/spawned)

When the agent hands a task to a separate session (see "Spawn separate sessions"),
it runs in the background, often on its own branch and worktree.

`/spawned` lists what this chat started: which are still running, which finished, and
what branch each one is on. Pick a number to open one.

- **Opening doesn't interrupt.** You see a running session's work so far while it
  keeps going.
- **Not the same as `/resume`,** which reopens any saved chat in this folder, whether
  or not this session started it.

## Scheduled runs

Ask the agent for a recurring (or one-time) background run, such as "every morning
at 9, run the tests and summarize failures", and it stores a schedule with
`schedule_run`. At each occurrence, a fresh session starts with the stored prompt,
under the approval policy of the chat that created it.

### Schedule formats

All times are local.

- `every <N>m|h|d` (minimum 5 minutes)
- `daily at HH:MM`
- `weekdays at HH:MM`
- `weekly on <day> at HH:MM`
- `once at YYYY-MM-DD HH:MM`

### Managing schedules

- `list_scheduled_runs` shows what's configured, with next and last fire times.
- `cancel_scheduled_run` removes one.
- Creating or cancelling a schedule asks for approval.

**When they fire.** Schedules survive restarts and fire while Houston (the desktop
app or the terminal) is running. It's an in-app scheduler, not OS cron: an occurrence
missed while Houston was closed fires once at the next launch.

## Review and multi-step tools

| Tool | Does |
| --- | --- |
| `review_changes` (or `/review`) | an adversarial review of uncommitted changes |
| `todo_write` | keeps a task list for multi-step work, rendered live in the transcript |
| `pr_sweep` | tracks batch pull-request work (author new PRs from a task list, or process a batch of existing open PRs) |
| `show_images` | shows you image files the agent produced |
| `render_mockup` | screenshots an HTML mockup without a dev server (desktop app) |
| `view_localhost` | loads and tests a page from your local dev server (desktop app) |

### Reviewing changes

`review_changes` (or `/review`) reviews uncommitted changes for correctness, security,
and quality.

1. An independent read-only reviewer runs per dimension, each in a fresh context.
2. A skeptical verifier re-checks every candidate against the real code and drops
   false positives.
3. You get the confirmed findings.

- **Live.** Findings appear under the review as each reviewer reports them, marked
  unverified, and update in place as the verifier confirms or rejects them. Once the
  review ends, rejected findings fold into a "dropped as false positives" line you can
  expand.
- **Click a finding** to see why it matters and the suggested fix.
- **Options:** scope it to a `base` branch or specific `paths`; raise `effort` to
  `high` to verify each finding with several independent skeptics; pass `model` to run
  the reviewers and verifiers on a cheaper sibling model.

### Showing images

`show_images` shows image files the agent produced, such as screenshots of an app or
rendered mockups.

- **Desktop app:** a captioned gallery. Click any image to open it full size, step
  through the set with the arrow keys, compare it with a "before" image using a slider
  when the agent paired one, copy it, save it, show it in the Files panel, or open it
  in its default app.
- **Terminal:** each image is a clickable link to its file.
- **No approval needed.** It only reads image files (PNG, JPEG, GIF, or WebP, up to
  5 MB each, 12 per gallery) inside the project.
- Images go to the model scaled down to at most 1568 pixels on their long side; the
  chat keeps the full-size originals.

### Rendering a mockup

`render_mockup` (desktop app) turns an HTML mockup file in the project into
screenshots without a dev server, shown as a gallery marked "Mockup from code".

- **Sizes and themes:** desktop, tablet, or mobile; light or dark; or a custom size.
- **Locked down.** The page runs in a hidden browser that can load its own files from
  the project folder, but nothing from the network or elsewhere on your computer.
- **No approval needed.** It writes nothing.

### Viewing your running app

`view_localhost` (desktop app) loads a page from a dev server on your computer in a
hidden browser, and shows the agent a screenshot plus the page's visible text and
console output.

- **Steps.** It can run steps first: fill a field, click or double-click, press a key
  such as Enter or Escape, wait for an element, check that some text is or isn't
  shown. So the agent can try a flow such as logging in or submitting a form, and get
  a pass or fail for each step.
- **Several views at once.** It can capture the page in several viewports or color
  schemes in one call (desktop, tablet, or mobile; light or dark; or the full page
  height), shown as a gallery marked "Running app". Steps then run with only one of
  them.
- **One call, one flow.** Each call starts from a fresh page load, so a flow runs
  within one call.

**Safety:**

- Every call asks for approval. A call with steps is approved separately from plain
  views, and the approval lists each step (never the text being typed).
- Text typed into a password field is never shown back to the agent.
- Steps can't download or upload files, or use your camera, microphone, or location.
- The page can't leave localhost.

## Hooks

Hooks (Settings, *Hooks*) run your own shell commands at set points in the agent loop.
Each hook names an event and, for tool events, a matcher glob on the tool name. The
other events match only an empty or `*` matcher.

### Events

| Event | When | What it can do |
| --- | --- | --- |
| **PreToolUse** | before a tool call runs | block the call, approve it (skipping the approval prompt), or rewrite its arguments |
| **PostToolUse** | after a tool call | append output to the tool result so the agent sees it (auto-format after every edit, run tests after a write) |
| **UserPromptSubmit** | when you submit a message, before the turn runs | block the prompt or inject extra context |
| **SessionStart** | once when a run begins | add context to the system prompt |
| **Stop** | when the agent would end its turn | force another turn with the reason fed back ("run the tests before you stop"), bounded so a hook can't keep the agent going forever |
| **PreCompact** | before the conversation is compacted | fold context into the material being summarized, so it survives compaction |

### The exit-code contract

The simplest way to write a hook:

- a non-zero exit blocks the blocking events (PreToolUse, UserPromptSubmit, Stop)
- plain stdout and stderr are fed back to the agent

### JSON output

For finer control, a hook prints a single JSON object on stdout:

| Field | Effect |
| --- | --- |
| `decision` | `"block"` vetoes the action even on a zero exit; `"approve"` (PreToolUse only) skips the approval prompt. A block always wins over an approve. |
| `reason` | a human-readable explanation, fed back to the agent (and shown with a block) |
| `additionalContext` | extra context added where the event fires: the tool result (PreToolUse), your message (UserPromptSubmit), the system prompt (SessionStart), or the material being summarized (PreCompact) |
| `updatedInput` | (PreToolUse only) replacement arguments the tool runs with |
| `systemMessage` | a note for you, never added to the model's context |

**Rewrites are re-checked.** A rewrite that fails the tool's schema fails the call
rather than falling back to the original arguments. Rewritten arguments are matched
against your permission rules again, so the approval decision is made on what will
actually run: a rewrite that lands on a deny rule is refused outright, even if the
hook also approved. A hook can tighten policy, but it can never loosen a managed or
project deny.

### How hooks run

- **Several matches** run in order. Any block wins, and the last rewrite wins.
- **Sandboxed:** hooks run in the same project sandbox as `run_shell`, with no
  network.
- **Failing safe:** a hook that can't be started counts as failed, so a PreToolUse or
  UserPromptSubmit hook that can't run blocks rather than lets the action through.

### Environment variables

| Variable | Holds |
| --- | --- |
| `$HOUSTON_HOOK_EVENT` | the event name |
| `$HOUSTON_TOOL_NAME` | the tool name |
| `$HOUSTON_TOOL_INPUT` | the tool's arguments |
| `$HOUSTON_TOOL_RESULT` | the tool result (PostToolUse) |
| `$HOUSTON_USER_PROMPT` | your message (UserPromptSubmit) |

**Large payloads.** A payload over 16 KB (a large write, a long tool output, a long
pasted prompt) is too big for an environment variable, so it's written to a private
temp file instead. The variable is left unset, and `$HOUSTON_TOOL_INPUT_FILE`,
`$HOUSTON_TOOL_RESULT_FILE`, or `$HOUSTON_USER_PROMPT_FILE` holds the file's path. A
hook that may see large payloads should read whichever of the two is set. The file is
removed once the hooks finish.

## Plugins

Drop a JS file in `.houston/plugins/` to register *observational* lifecycle hooks for
logging, metrics, or notifications:

`houston.on('onToolStart' | 'onToolResult' | 'onUserMessage', fn)`

- **Opt-in.** Plugins are local trusted files (the same trust model as hooks, agents,
  and skills) and run only when you've opted into project plugins for that project.
- **Isolated.** Each runs in its own context with no `require`, `process`, or network.
- **Observe only.** A plugin can't block or change a call; use a PreToolUse shell hook
  for that.
- **Can't break a run.** A plugin that throws or runs slowly is caught and ignored.

## MCP servers

Connect Model Context Protocol servers in Settings: a local **stdio** process, or a
remote **HTTP** (streamable) or **SSE** endpoint.

- **Naming.** Their tools are offered to the agent as `mcp__<id>__<tool>`.
- **Approval.** MCP tools always require approval.
- **Many tools, loaded lazily.** With more than 15 MCP tools connected, Houston loads
  their schemas on demand: they join the `find_tools` catalog (see "Tools loaded on
  demand" under "Context, worktrees, and history"), and the agent pulls in only the
  tool definitions it needs instead of sending every schema on every request.

### Signing in

Remote servers take custom headers (such as a static `Authorization: Bearer` token),
or **OAuth** for servers that need a sign-in:

- **Sign in:** click *Sign in (OAuth)* on the server in Settings (desktop), or run
  `/mcp login <n>` (terminal). Houston discovers the server's authorization server,
  registers itself as an OAuth client automatically, and opens the browser to
  authorize.
- **Tokens** are stored encrypted, sent as the bearer on every connection, and
  refreshed automatically when they expire.
- **Sign out** (or `/mcp logout <n>`) forgets them.
- An explicit Authorization header, when set, takes precedence over OAuth tokens.

### Local (stdio) servers

- Give them a working directory and environment variables in Settings, or through the
  `/mcp add` prompts.
- The spawned process gets a base environment with credentials stripped, so a token
  the server needs must be listed explicitly.
- Environment values are treated as secrets and stored encrypted, like header values.

### Resources and prompts

When a server exposes MCP resources or prompt templates, the agent gets meta-tools to
discover and fetch them: `mcp_list_resources` / `mcp_read_resource` and
`mcp_list_prompts` / `mcp_get_prompt`.

Houston also:

- honors `list_changed` notifications, so tools, resources, and prompts refresh live
- keeps long tool calls alive while the server reports progress
- caps any single MCP result, so a runaway server can't flood the context window

### Checking a server

- `/mcp tools <n>` lists exactly which tools a server exposes. A count tells you it
  works; the names tell you what you just handed the agent.
- `/mcp` in the terminal and the Settings panel show each server's live status:
  connected with a tool count, needs sign-in, or the connection error.

### Server questions (elicitation)

A server can ask for input in the middle of a tool call, such as a region, a project
name, or a confirmation.

- **Desktop app:** a small form naming the server, with typed fields and Submit /
  Decline. Your answer goes to that MCP server, not to the model.
- **Terminal:** an inline prompt (decline with `n`).
- **Headless or background runs:** declined automatically, so nothing hangs waiting
  for a user who isn't there, and the server proceeds along its no-answer path.
- Stopping the run cancels any open request.

### Protocol versions

Houston speaks MCP protocol versions 2025-06-18, 2025-03-26, and 2024-11-05, and asks
for the newest when it connects.

- A server that answers with an older supported version still works, but server
  questions need 2025-06-18: an older server's requests for input are declined.
- A server that only speaks a version outside that list fails to connect, and its
  status names the version it asked for.

## Shell sandbox and network

Shell commands run under the host OS sandbox where one exists, confined to the
project folder: writes outside the project are blocked, and network access is off by
default.

| Platform | Sandbox |
| --- | --- |
| macOS | Seatbelt (`sandbox-exec`) |
| Linux | bubblewrap (an unprivileged user namespace), when available |
| Windows | none broadly available, so shell commands run unconfined. Houston reports them as not sandboxed and never silently auto-approves one. |

The structured file tools stay confined to the project on every platform.

**Working across repos.** **Additional folders** (Settings) adds folders to the file
tools' allowed roots and to the shell sandbox.

### Network for shell commands

Network from `run_shell` is *gated*, not permanently off, and full auto doesn't imply
it. The sandbox can read your whole filesystem, so blanket outbound access plus full
auto would be a one-command read-and-exfiltrate.

**Shell reaches the network only after a conscious grant for the chat:**

- **Full auto:** the **shell-network consent**, asked once after a command first fails
  without network.
- **Ask / auto-edit:** "Allow for run" on a shell command.

Plain "Allow" and "Always allow" run that one command offline, and until the run has
the grant, each shell approval prompt says so.

A command that needs the network (cloning, installing dependencies, `gh`, `curl`)
isn't impossible; it just needs that grant. Declining runs the command offline instead
of blocking it.

**Headless runs** (`-p`) have no prompt to grant it from, so the grant is a flag:

- `--allow-shell-network` lets shell commands reach the network for that run under any
  policy. It isn't remembered for the next run.
- Without it, shell runs offline, except under `--full-auto`, where
  `--on-approval allow` (its default) also answers the shell-network consent when a
  command fails without network.
- `--on-approval allow` alone never grants it under ask or auto-edit, since it
  approves each command the way plain "Allow" does.

**Installs behave well offline and online:**

- Offline, npm, pip, and cargo skip their usual retries, so an install that needs the
  network fails in about a second instead of a minute or more.
- Package-manager caches (npm, pip, yarn) are redirected to a writable temp folder, so
  installs need no cache workaround once network is on.
- On macOS, Python's bytecode cache goes there too, since the system `python3` keeps it
  under `~/Library/Caches`, which the sandbox can't write.

### Finding your toolchain

An app opened from the Dock doesn't read your shell startup files, so Houston adds the
usual places runtimes live to the shell's `PATH`: Homebrew, nvm's default Node, fnm,
Volta, mise, asdf, pyenv, rbenv, and the per-user bin folders of Rust, Go, Bun, and
Deno.

A sandboxed command may stop processes it started (build tools do this with their
workers), but nothing outside its own sandbox.

### When a runtime is missing

If a command fails because Node.js, Python, Go, Rust, Deno, or Bun isn't installed:

- the transcript says so and offers **Install**, which runs the install command (for
  example `brew install node`) in a new tab of the built-in terminal, outside the
  sandbox, so you can watch it and answer any prompt
- there's also a link to the official download page
- the agent is told not to attempt system installs itself, and to wait for you rather
  than write code it can't run

The terminal clients print the same install command.

### Egress allowlist

Granted shell network isn't unrestricted. On macOS and Linux it's routed through a
local proxy Houston controls, and the OS sandbox blocks any direct connection, so the
proxy is the only road out.

**The proxy allows a destination only if its domain is on the allowlist:**

- a built-in set of development infrastructure: package registries such as npm, PyPI,
  crates.io, RubyGems, Maven, and Go, and code hosts such as GitHub, GitLab, and
  Bitbucket
- plus any domains you add in Settings under **Sandbox egress**

**How it behaves:**

- Each entry also covers its subdomains.
- A deny list wins over every allow.
- Edits apply immediately, mid-run.
- A refused destination fails with an `EGRESS_BLOCKED` message naming the domain.
  That's policy, not an outage.
- Only HTTP(S) flows through the proxy, so other protocols (SSH, for example) are
  blocked under the allowlist. Use HTTPS remotes inside the sandbox, or switch the
  egress mode to "All domains" (Settings) to restore unrestricted granted network.
- On Windows, where no OS sandbox exists, the allowlist can't be enforced.

**Linux and dev servers.** Each command runs in its own network namespace whenever
shell network isn't granted, and also under the allowlist. So a dev server started
inside the sandbox is reachable only from that same command: not from the Preview
panel, `view_localhost`, or later commands. Granting shell network with "All domains"
restores the shared network. The agent is told this on Linux, and checks web apps with
requests from the command that starts the server.

### Secret redaction

Tool results, the transcript, and logs are scrubbed before the model or the interface
sees them:

- well-known token formats, and this install's stored secrets, become
  `[redacted:…]`
- a `NAME=value` line whose name marks it as a secret (`SESSION_SECRET`,
  `ADMIN_PASSWORD`, `GITHUB_TOKEN`, `STRIPE_API_KEY`, and the like), as `cat .env`,
  `env`, or `grep` prints it, keeps its name but shows the value as
  `[redacted:env-secret]`

So the agent refers to such a value by variable and file rather than repeating it.
A file write that would put a `[redacted:…]` placeholder where a value goes is
refused, so writing back a file it read can't replace the real secret with the
placeholder.

### Credential masking on egress

Houston's own network tools refuse to *send* a credential:

- Before a `web_fetch` or `web_search` leaves the machine, its URL or query is scanned
  for a well-known token format or one of this install's stored secret values. The
  call is refused if one is present.
- The GitHub tools scan everything they send the same way (titles, bodies, comments,
  reviews).

This is the outbound counterpart to secret redaction (which scrubs secrets on the way
back in), so a prompt-injected agent can't leak a key by pasting it into a request.
It covers Houston's own tools; a raw `curl` inside `run_shell` is bounded by the
shell-network consent instead.

### Untrusted content

A fetched page is written by whoever runs the site, an issue comment by whoever
posted it, and an MCP result by whoever wrote what the server relays. So Houston
treats the text these tools return as data, not instructions, without relying on the
agent choosing to see it that way.

**Covered tools:**

- `web_fetch` and `web_search`
- GitHub tools that read issue and pull request text: `gh_issue_view`,
  `gh_issue_list`, `gh_pr_view`, `gh_pr_list`
- GitHub tools that read CI: `gh_run_view`, `gh_run_list`, `gh_pr_checks`. A pull
  request from a fork runs the fork's own workflow files, so its author writes the job
  and step names and everything its steps print to the log.
- MCP tool results and resources

#### Fencing

That text is wrapped in an `<untrusted-content-NONCE>` fence with a fresh random nonce
per call, and the system prompt tells the agent that anything inside is
attacker-controlled. The nonce is what makes the fence hold: with a fixed tag, the
text could close the fence itself and carry on as if it were trusted.

- **Outside the fence:** fields GitHub guarantees, such as an issue's number, state,
  author, and URL, or a CI run's id, outcome, and URL, so the agent can rely on them.
- **Inside the fence:** titles, bodies, labels, branch names, diffs, workflow, job,
  step, and check names, and CI logs.
- **One fence per comment,** with its author shown outside it, so one comment can't
  pass itself off as a maintainer's reply.
- **GitHub writes** (opening, commenting, reviewing, merging, checking out, closing,
  reopening) report the outcome in a line Houston writes, plus the new item's URL, and
  fence everything `gh` printed, since its messages quote titles and branch names.

#### Isolation

Content is scored for injection signals: text telling the reader to ignore prior
instructions, a new persona, an instruction to send data to a URL, references to key
material, text telling the reader to call Houston's own tools, and characters hidden
from a human reader.

A web page or MCP result that looks like an attempt isn't inlined at all. A separate
model call, with no tools and no conversation history, reads it and reports what it
says, and only that report reaches the agent. The isolation is structural: there's
nothing for the content to act through, and no earlier instructions to talk it out
of. If that call fails, the content is withheld rather than passed through.

#### Warning

GitHub text and web search results that look like an attempt stay inline and fenced,
with a warning naming the signals:

- the agent needs an issue's exact repro steps or a pull request's exact diff to do
  its job, and a summary wouldn't do
- search results are short snippets, and any page the agent then opens goes through
  `web_fetch` and its isolation
- diffs and CI logs are fenced but not scored, because code and build output routinely
  contain the phrases the scoring looks for

#### Cost and limits

- Ordinary content is unaffected and arrives verbatim, so documentation and code
  samples stay byte-exact. Only flagged content pays for the extra call.
- The score is deliberately loose, because a false positive costs one model call and
  some fidelity rather than a failed call.
- Bidirectional text controls, which can make text display in a different order than
  it reads, are stripped from all fenced content.
- This is defense in depth behind the approval gate (you still approve network and
  MCP calls), not a replacement for it. The classifier is a heuristic, and anyone who
  knows it's there can word around it.

## GitHub tools

When the `gh` CLI is installed and signed in, Houston offers dedicated tools for the
GitHub loop.

| Area | Tools |
| --- | --- |
| Pull requests | `gh_pr_create`, `gh_pr_list`, `gh_pr_view`, `gh_pr_comment`, `gh_pr_review`, `gh_pr_checkout`, `gh_pr_checks`, `gh_pr_merge`, `gh_pr_set_state` |
| Issues | `gh_issue_list`, `gh_issue_view`, `gh_issue_create`, `gh_issue_comment`, `gh_issue_set_state` |
| CI runs | `gh_run_list`, `gh_run_view` |
| Repositories | `gh_repo_create` |

**What the less obvious ones do:**

- `gh_pr_review` submits an approve, request-changes, or comment review.
- `gh_pr_merge` lands an open PR (merge commit, squash, or rebase, optionally deleting
  the branch).
- `gh_pr_set_state` closes or reopens a PR, marks a draft ready for review, or converts
  it back to a draft.
- `gh_issue_set_state` closes an issue (as completed, not planned, or a duplicate of
  another issue) or reopens it.

**How they run:**

- **Your own `gh`.** They drive your local `gh`, so no token is stored in the app.
- **Approval.** Each call is network-gated (it always asks), and the ones that change
  something are refused in plan mode.
- **Network on approval.** They run `gh` outside the shell sandbox, so they reach the
  network once approved, unlike a raw `gh` in `run_shell`.
- **Optional.** If `gh` isn't installed, these tools aren't offered, and everything
  else still works.

## Remembering an instruction (#)

Start a line with `#` to turn it into a standing instruction:

`# always run the linter before committing`

1. Houston asks whether it applies to this project or to you everywhere.
2. It appends the note to the rules file it already reads on every run: `AGENTS.md` in
   the project, or `~/.houston/AGENTS.md` for everywhere.
3. It tells you which file it wrote.

It's for the moment you notice "it should always do X", when you're least likely to
stop and open an editor.

- A path written with `@` in a note (`@~/notes.md`) is kept as text, shown in
  backticks, and never loaded as an import. To import a file, edit the rules file
  yourself.
- `#` alone isn't a note, and a `#` in the middle of a line is ordinary text.

## Project rules

Houston folds a small hierarchy of rules files into the system prompt on each run, in
this order:

1. the global `~/.houston/AGENTS.md`
2. the project's own `AGENTS.md` / `CLAUDE.md` at its root
3. any `AGENTS.md` / `CLAUDE.md` in subfolders, shallowest first

Use them for coding conventions, build and test commands, and house style. Houston
treats them as conventions, not as authority to change tool or permission behavior.

- **Imports.** Any rules file can pull in others with `@path` imports.
- **Skipped folders.** In a git repository, subfolders the project's `.gitignore`
  excludes (dependencies, build output) are never searched for rules. Outside git,
  well-known dependency and build folders are skipped.
- **No duplicates.** When two files hold the same rules (a `CLAUDE.md` that links to
  `AGENTS.md`, or an identical copy), Houston loads them once.
- **Size cap.** All rules together are capped at 32,000 characters. When they run over,
  the global file is shortened (or left out) first, so your project's own rules still
  fit, and Houston tells the model which files were cut.

### Using `~/.claude/CLAUDE.md`

Houston doesn't load `~/.claude/CLAUDE.md` on its own. To use it everywhere, add this
line to `~/.houston/AGENTS.md`:

```
@~/.claude/CLAUDE.md
```

When Houston finds that file and your global rules don't import it yet, it offers once
to add the line for you (**Import it**) or leave things as they are (**Keep
separate**). Rules after the import line win where the two disagree.

## Context, worktrees, and history

### Compaction

When a conversation grows too large, Houston keeps it inside the model's context
window:

1. it first trims large tool output the agent has moved past (the agent can re-read
   anything it still needs)
2. then it summarizes the older part of the conversation, including the earlier steps
   of one long request

- **Your current request is always kept word for word.**
- **Sized to the model.** The threshold is set automatically from the selected model's
  context window: a large-window model compacts later, a small local model sooner.
- **Built up, not redone.** The summary is saved with the conversation, so later turns
  extend it instead of re-summarizing from scratch.
- **Nothing disappears on screen.** The full transcript stays visible; only what's sent
  to the model is compacted.
- **Settings:** set a fixed token threshold, or turn compaction off, in Settings,
  *Agent Behavior*, *Context window*.

### Tools loaded on demand

Every tool definition sent to the model costs context on every request, so Houston
preloads only the tools a coding task uses all the time:

- reading, searching, and editing
- the shell, the todo list, questions, and plans
- research subagents, skills, and the web
- git status and diff

The rest are listed with a one-line summary in a `find_tools` catalog, and the agent
loads one when it needs it: the GitHub tools, scheduled runs, spawned and proposed
sessions, the localhost preview, images and mockups, notebook editing, `ast_grep`,
`review_changes`, `recall_history`, `pr_sweep`, and writable subagents.

- A loaded tool stays loaded for the rest of the conversation.
- Loading changes only what the model sees. Approval modes, plan mode, permission
  rules, and hooks apply to these tools exactly as to the preloaded ones.

### Worktrees

In a git repo, a new chat runs in a fresh, isolated worktree on its own branch under
`.houston/worktrees/` by default, so the agent's edits never touch your current
checkout.

- Untick **New worktree** to work in the repo directly.
- In a repo whose current branch has no commits yet (a fresh `git init`), the toggle
  starts off. A worktree can only branch from a branch that has commits, and isn't
  offered when no branch has any.

### Conversations

- Saved per project folder.
- Searchable, and you can fork them.
- **Export** as JSON or self-contained HTML, and **import** from either. An HTML export
  from an older version brings back only the chat text.
- **The File menu** starts a new chat (⌘N), a new chat in another folder (⇧⌘N), or one
  in a recent folder (**Open Recent**), and imports or exports chats.

### Undoing a turn's file changes

Before the agent edits a file, Houston snapshots it, so the latest turn's changes can
be reverted with one click (and re-applied after a revert).

- **Covers every file-editing tool,** including multi-file patches (adds, updates,
  deletes, and moves) and edits made by a writable subagent the turn dispatched.
- **Survives restarts.** Checkpoints are kept on disk in your Houston profile, for the
  most recent 200 turns.
- **Shell side effects aren't covered.** Revert only restores files the editing tools
  touched.

To go back further than the last turn, see "Rewinding to an earlier message".

## Help menu

The desktop app's **Help** menu is last in the menu bar on every platform.

- **Houston Guide** opens this guide on houstoncode.ai/docs, written for the latest
  release.
- **Report an Issue** opens a new GitHub issue.
- **Take the Tour…** plays the getting-started tips again.
- **On macOS** it also has the system search field: type part of a command's name (for
  example "settings") to find it in the menus.
- **On Windows and Linux** it also holds **Share Houston…** and **Check for
  Updates…**, which sit in the app menu on macOS.

## Sharing Houston

To invite a friend, any of these works:

- **Share Houston** at the bottom of the sidebar (the share icon when the sidebar is
  collapsed)
- **Share Houston…** in the app menu on macOS, or the Help menu on Windows and Linux
- "Share Houston" in the command palette
- `/share` in the terminal, which copies the invite (where the terminal allows
  clipboard access) and prints it

**What happens next:**

- **macOS:** a menu with **Copy invite** and **Share via** (AirDrop, Messages, Mail,
  and any app that adds itself to the system share menu).
- **Windows and Linux:** the invite is copied right away, with options to copy it
  again or send it by email.

The invite links to https://houstoncode.ai with no tracking parameters.

## Settings and keys

Settings opens as a full page over the window. **Back to app** (at the top of the
sidebar) or `Esc` returns to the chat.

### Pages

| Group | Pages |
| --- | --- |
| **AI** | Providers & Models, Agent Behavior, Tools, MCP Servers, Hooks |
| **App** | General, Appearance, Keyboard |
| **Security** | Permissions (the default approval mode, permission rules, trusted folders, sandbox egress), Workspace (additional folders the agent may use) |
| **About** | installed version and a manual "Check for updates", diagnostics, legal |

**Check for Updates…** is also in the app menu on macOS, and the Help menu on Windows
and Linux.

**API keys** are encrypted with the OS keychain and stay in the app's main process.

### Saving and undo

- **No Save button.** A switch, a choice, or a reorder saves at once; a text field
  saves when you leave it (so a half-typed pattern is never saved).
- **Undo.** The title bar shows when a change is saved and offers **Undo** for the last
  one.
- **Modified sections.** A section whose preferences differ from the defaults is marked
  **Modified**, with a **Reset** beside it.

**Your preferences** (General) exports them to a file, imports one, or resets them all:

- Importing first says what it replaces, and calls out any rules that allow calls or
  hooks that run commands.
- Exports leave out providers, API keys, MCP servers, and folders.
- A reset keeps those, plus your permission rules, hooks, and approval mode (whose
  fresh-install default depends on whether this machine's sandbox works).

### Searching settings

The search box above the pages is focused when Settings opens (`Cmd+F` or `Ctrl+F`, or
`/`, jumps back to it). It finds a setting from any page by:

- its name or description
- a common synonym ("proxy" finds Sandbox egress, "dark mode" finds Appearance)
- a value you entered (a model id, an MCP server, a rule pattern)

Results stay editable in place, the nav shows how many each page has, and `Esc` clears
the search.

### When a key won't save

If the OS keychain is unavailable, Settings (and the Get started checklist's Connect
panel) says how to fix it and offers **Restart Houston**.

- **macOS:** this usually means the Keychain prompt was denied. macOS only asks again
  after a restart, so restart and choose **Always Allow**.
- **Linux:** unlock or install a keyring (such as GNOME Keyring or KWallet), then
  restart.

## Getting started in the desktop app

On first launch, the welcome screen shows a three-step **Get started** checklist:

1. **Connect a model.** Paste an API key for Anthropic, OpenAI, or Gemini (it's checked
   with a live model listing before it's saved), or point at a local Ollama or LM
   Studio server.
2. **Open a project folder.**
3. **Send a first task.** When only this step is left, the cursor moves into the
   message box (which glows) and the step suggests a task: "Explain how this project is
   organized." for a folder with files, or "Build a simple to-do list web page in this
   folder." for an empty one.

Each step ticks itself off from the app's real state, and the checklist goes away for
good once the first task is sent.

**Changing your mind.** While the checklist is open, each finished step shows what it
set and has a **Change** button, so you can switch model, provider, or folder before
your first task:

- on "Connect a model" it reopens the panel with the saved key (**Replace key** swaps
  it) and a model picker
- on "Open a project folder" it reopens the folder picker

### Tips along the way

A few one-time tips point at controls the first time they matter:

- the approval mode, the **New worktree** toggle, and the message box (`@` files, `/`
  commands, `#` rules), a couple of seconds before your first message (you can keep
  typing meanwhile)
- **Revert** and **Changes**, after the first turn that edits files

**Skip tips** or `Esc` dismisses them.

**Take the tour** plays the tips any time, and also covers steering (see "Typing while
it works"). Find it in the command palette (⌘K) or under **Help → Take the Tour…**. If
you used Houston before this feature, nothing appears on its own.

## License and legal

Houston is open-source software under the **Apache License 2.0** (`LICENSE` in the
repository, and a copy inside the packaged app under `Resources/`). There's no
account and no terms to accept: Houston opens straight into the app.

### What the license lets you do

Anyone can use Houston for any purpose, read and modify the source, and redistribute
original or modified copies, commercially or not, as long as they:

- keep the license and copyright notices
- pass along the `NOTICE` file
- state which files they changed

The license also carries an express patent grant from every contributor. It disclaims
all warranties, and it doesn't license the Houston brand.

### The name and logo

The brand is held back in two ways, because a name and a piece of artwork are
protected differently:

- **The name** is a trademark, and Apache-2.0 section 6 grants no trademark rights.
- **The logo** is also copyrightable artwork, so the icon and logo files are carved out
  of the Apache grant explicitly in `NOTICE`.

Everything else in the repository, source and non-source alike, is Apache-2.0 with no
carve-out.

`TRADEMARK.md` sets out what anyone may do without asking: redistribute unmodified
builds under the name, package Houston for a package manager, refer to Houston in their
own work, and fork it and say so. In return, a modified build handed to other people
should carry a different name.

### Contributing

Contributions are covered by the same license under Apache-2.0 section 5, so there's
no CLA to sign. See `CONTRIBUTING.md`.

### Your data

- Houston stores conversations, settings, and project data on your machine and sends
  no telemetry anywhere.
- Prompts, code, and files go only to the model and other providers you configure,
  under those providers' own terms and model-training policies.
- Third-party components bundled into the app are listed with their license texts in
  `THIRD-PARTY-NOTICES.md`, which also ships inside the packaged app.
