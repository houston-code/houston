# Houston: product guide

This is Houston's own reference for how Houston works. When the user asks how to
do something *in Houston itself* (its slash commands, skills, subagents, hooks,
plugins, MCP servers, approval modes, permission rules, plan mode, sandboxing,
GitHub tools, settings, or keyboard shortcuts), answer from this guide rather
than describing a generic assistant. Relay the relevant part concisely and point
at the exact setting or file. If a detail is not covered here, say so instead of
guessing, and offer to look it up in the project.

## What Houston is

Houston is a coding agent that runs on the user's own machine and works inside a
single project directory. It brings its own model connections (the user supplies
API keys, or runs a local model), a set of file, shell, search, web, and GitHub
tools, and a permission system that decides how much runs without asking. It
ships as a desktop app and as terminal clients.

## Clients (where Houston runs)

- **Desktop app.** The full GUI: chat sidebar, diffs, preview panel, settings.
- **Interactive terminal (`houston -i`).** A stay-resident REPL in the terminal.
  `--continue` reopens this folder's most recent chat at launch, `--resume <id>` a
  specific one.
  Conversation streams live, approvals and questions are answered inline, and
  slash commands switch settings mid-session. See "The terminal composer" below
  for how to type, paste, and edit a message.
- **Headless (`houston -p "<prompt>"`).** Runs one prompt and writes the result
  to stdout, each model round's text once that round has finished, then exits.
  Read-only by default; add `--full-auto` to let it edit and run commands,
  `--json` for machine-readable events. Good for scripts and CI.
  With no human to answer approval prompts, `--on-approval <allow|deny|fail>`
  decides what a gated tool call gets: denied by default (allowed under
  `--full-auto`), with `fail` also exiting non-zero so a script can tell the run
  hit a permission wall. Nobody can answer a question either, so a headless run
  doesn't offer the agent `ask_user`: it is told no user is available, makes the
  call itself, and states its assumptions in the final answer. Approving a shell
  command with `--on-approval allow` is plain "Allow", so it runs without network;
  pass `--allow-shell-network` to let shell commands reach the network for the run
  (see "Shell sandbox and network").
  - **Prompt from stdin.** `-p -` reads the prompt from stdin, and so does a `-p`
    with no value when input is piped in (`cat task.md | houston -p --json`). The
    standalone CLI also reads a piped prompt with no `-p` at all.
  - **Per-run settings.** These apply to the one run and never change your saved
    settings: `--effort <off|low|medium|high|xhigh>` sets the reasoning effort;
    `--max-turns <n>` caps the model steps (a hard cap that never auto-extends);
    `--max-cost <usd>` tells the agent to wrap up once the run's estimated cost
    reaches that amount (a soft ceiling: the step in flight still finishes);
    `--verify <command>` runs that command when the agent stops after editing
    files and sends a failure back for a bounded fix-up pass (it needs a policy
    that can edit, such as `--full-auto`). A bad value exits 2 before anything runs.
  - **`--json` result line.** After one JSON line per agent event, the last line
    is a summary: `{"type":"result", "status", "stopReason", "limitReason"?,
    "turns", "costUsd", "inputTokens", "outputTokens", "durationMs", "finalText",
    "receipt"?}`. `status` is `success`, `limit`, `stalled`, `approval_denied`, or
    `error`; `finalText` is the agent's closing answer (the text after its last tool
    call); `receipt` is Houston's record of what the run actually ran (see "What
    actually ran"), present when it ran checks or changed files.
  - **Exit codes.** 0: the agent finished on its own. 1: an error or aborted run,
    a stalled agent, or a call refused under `--on-approval fail`. 2: a usage
    error (a bad flag value, or an empty prompt on stdin); nothing ran. 3: the run
    hit a budget before finishing (its step cap or the model's output limit).
- **Standalone CLI.** The same `-p` and `-i` clients as a single self-contained
  Node script, with no desktop app and no browser engine. Runs on headless Linux
  servers; API keys come from environment variables.

All clients share one agent core, so tools, permissions, and skills behave the
same across them. Some surfaces are desktop-only (the preview panel, spawning
separate sidebar sessions, viewing localhost screenshots).

## Models

Bring any model with your own key: Anthropic, OpenAI, Google, any
OpenAI-compatible endpoint, or a local model runtime. Add a provider and key in
Settings, fetch its live model list, and pick a model. The picker shows each
model's context window and capability badges (tool calling, vision, reasoning)
and warns before you pick one that cannot call tools. Keys are stored encrypted
by the OS keychain and never touch the renderer. The selection is shared across
clients: picking a model in the desktop app or switching with `/model` in the
terminal saves it as the default for future sessions.

If a provider answers that it doesn't serve a model (the id is mistyped, the model
was retired, or your key can't use it), the turn ends with a message saying so
instead of the raw error, and the model is marked "Not found" in the picker
("(not found)" in `/model`) until it answers a request again. Pick another model
and retry.

### Claude through your cloud account

If your Claude access runs through a cloud account rather than an Anthropic API
key, add "Amazon Bedrock (AWS credentials)", "Google Vertex AI", or "Microsoft
Foundry" from the provider picker in Settings. All three behave like the
Anthropic provider once added: the same streaming, extended thinking, and prompt
caching.

Bedrock and Vertex do not ask you for an API key, because neither uses one. They
sign requests with the credentials already on your machine:

- **Bedrock** uses the standard AWS credential chain, so an `~/.aws/credentials`
  profile, an SSO login, or an instance role all work as-is. Set the region in
  Settings (or export `AWS_REGION`). If you have an Amazon Bedrock API key
  instead, you can enter it as an optional key, and it takes precedence over your
  AWS credentials. There is also a separate "Amazon Bedrock (API key)" provider
  for that case alone.
- **Vertex** uses Google Application Default Credentials: run
  `gcloud auth application-default login` if you have not already. Set the region
  in Settings (or export `CLOUD_ML_REGION`). The project is usually inferred from
  your credentials, so leave it blank unless you need a specific one.
- **Foundry** is the exception: it does take an API key, the one from your
  Foundry resource. Enter it in Settings along with the resource name, the
  `my-resource` part of `https://my-resource.services.ai.azure.com` (or export
  `ANTHROPIC_FOUNDRY_RESOURCE`).

Each host addresses models its own way: Bedrock prefixes the vendor
(`anthropic.claude-opus-4-8`), while Vertex and Foundry take the plain id, and
Vertex also accepts a dated snapshot (`claude-opus-4-5@20251101`). The model
picker shows them under one name either way. None of the three publishes a model
list, so Houston ships a curated one and "Fetch" restores it rather than calling
out to the network. If your account has access to a model that is not listed, add
its id to the list by hand.

### GPT models on Azure OpenAI

Add "Azure OpenAI" from the provider picker to use GPT models on your own Azure
resource. It needs three things from Settings:

- **API key**, from your Azure OpenAI resource.
- **Endpoint**, the resource URL, e.g. `https://my-resource.openai.azure.com`
  (or export `AZURE_OPENAI_ENDPOINT`).
- **API version**, the `api-version` Azure serves your deployments at. Houston
  pre-fills a widely supported one; a newer model may need a newer version, which
  you can change here without waiting on a Houston update.

Azure serves models as **deployments you name yourself**, so there is no model
list to fetch and none to ship. Each model id in the provider's list is a
deployment name: add the names you created in the Azure portal, and Houston sends
each request to that deployment. One provider covers as many deployments as you
have, so a resource with separate GPT deployments needs only one entry here.

### Dropped connections

When the provider is overloaded, rate-limiting, or drops the connection, Houston
retries the turn with a growing pause between attempts, telling you it is
retrying. That holds even when part of the reply had already appeared: the
partial reply is discarded and the turn starts over, so you only ever keep one
copy of the answer. The desktop app removes the partial text, the terminal
marks it as discarded (it can't erase what it printed), and headless mode never
writes it to stdout. Any tool calls in a discarded reply never run. A failure
that isn't transient (a bad key, a malformed request) ends the turn instead.

### Fallback models

You can name next-choice models that Houston tries when your selected model
cannot serve a turn: the provider is overloaded or rate-limiting after Houston
has already retried, or the conversation no longer fits the model's context
window even after compacting. Set them as an ordered list in settings.json:

```json
"fallbackModels": [
  { "providerId": "openai", "model": "gpt-5" },
  { "providerId": "ollama", "model": "qwen2.5-coder" }
]
```

Entries are tried in order and may name any provider you have configured. One
that no longer resolves (you removed the provider, or its key is missing) is
skipped rather than failing the run. Any part of the reply that had already
appeared is discarded before Houston switches, so a fallback never splices two
models' output together, and it tells you in the transcript when a reply came
from a fallback. A request that failed for its own reasons (a bad key, a
malformed request) is not retried on another model, since it would fail there
too. A model the provider doesn't serve does move on to the next one. Leave the
list unset to have a failing model simply end the turn.

## Slash commands

Type `/` in the composer for the command menu. In the terminal it appears under
what you are typing and filters as you go, listing each command with what it does,
including any this project defines in `.houston/commands`. The exact set depends
on the client, but the common built-ins are:

- `/new` (alias `/clear`): start a fresh conversation.
- `/compact`: summarize older turns now to free up context.
- `/plan`: switch to plan mode (read-only). In the desktop app `/ask`, `/auto`,
  and `/full` switch the other approval modes; the terminal uses `/approval <policy>`.
- `/review`: run an adversarial review of your uncommitted changes and fix what
  it confirms.
- `/skills`, `/agents`: list the workspace's skills and custom agents.
- `/help`: list the available commands.

The interactive terminal adds terminal-specific commands such as `/model` (list
or switch model), `/login` (set an API key, also `/providers`), `/approval`,
`/settings`, `/doctor`, `/verbose`, `/output`, `/resume`, `/spawned`, `/proposals`, `/btw`, `/fork`,
`/cost`, `/mcp`, `/trust`, `/hooks`, `/theme`, `/image`, `/cwd`, `/share`, and `/exit`.

**Themes.** `/theme` lists the terminal's palettes and `/theme <name>` switches:
`dark` (bright foregrounds for a dark background), `light` (readable on white,
which the bright yellow a dark theme uses is not), `colorblind` (red and green carry
most of a diff's meaning, and that is the most common form of color blindness, so
this maps them to orange and blue instead), `mono` (no color at all), and
`default`. Your choice is remembered.

**Custom commands.** Any Markdown file in `.houston/commands/<name>.md` becomes a
`/name` command, in the project or in `~/.houston/commands` for one you want
everywhere. A project's command wins if both define the same name.

The file body is a prompt template. `$ARGUMENTS` is replaced with everything typed
after the command name, and `$1`, `$2`, … with the individual words, so
`/deploy staging v2` can fill a template that says `deploy $1 at version $2`. With
no placeholder at all, the args are appended.

Optional frontmatter sets the description; without it, the first line is used (so
existing commands keep working):

```markdown
---
description: Ship the branch to staging
---
Deploy the current branch and report what happened.
```

## The terminal composer

The interactive terminal's composer is a full line editor, so a message can be as
long as it needs to be.

**Pasting.** Paste anything, including many lines: the whole block lands in the
composer as one editable message and is never sent line by line. A large paste
collapses to a short placeholder like `[#1 pasted 120 lines]` so it does not bury
the screen; the real text is what gets sent. This works even in terminals without
bracketed-paste support.

**Multi-line messages.** `Enter` sends. To add a line break instead, press
`Ctrl-J` or `Alt-Enter`, or just paste one.

**Keys.**

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

**History.** Messages are remembered per project folder and survive restarts,
including multi-line ones.

**Vim keys.** `/vim` turns on modal editing in the composer and remembers it;
`/vim off` goes back. Each prompt starts in insert mode (so typing a message never
needs a mode change), `Esc` goes to normal mode, and the marker in front of the
prompt says which mode you are in: `I` or `N`. Terminals that support it also show
a bar cursor for insert and a block for normal.

Normal mode covers the muscle-memory core: motions `h j k l w W b B e E 0 ^ $ gg G`
with counts (`3w`, `d2j`), insert with `i a I A o O s`, edits `x X D C r`, the
operators `d c y` over any motion plus `dd cc yy`, `p`/`P`, and `u` to undo. What
is not there: visual mode, text objects (`ciw`), registers beyond the unnamed one,
marks, macros, and `.` repeat. Everything else in the composer (Enter to send,
`Ctrl-R` history search, `Ctrl-X Ctrl-E`, pasting) works the same in both modes.

**Running a shell command.** A line starting with `!` runs in your own shell. See
"Running your own commands" below.

## Seeing what the tools did

While a turn runs, each tool result collapses to one line: the transcript is a
conversation, not a log. Two ways to see more:

- **When something fails**, the error is shown without asking. A failed tool
  prints its first lines, so you can see why.
- **`/verbose`** shows each tool's full output as it runs (`/verbose off` to stop,
  or just `/verbose` to toggle).
- **`/output`** reprints the last tool result in full, after the fact. `/output 3`
  goes three results back. Nothing extra is stored for this: the whole output was
  always kept in the conversation, it just had no way out to the screen.

Very long output is capped with a note saying how much was left out.

## What actually ran (the receipt)

A turn that ran checks or changed files ends with a line marked **Recorded by
Houston** under the agent's last message, for example `No tests ran · install
failed (no network) · build failed · 14 files changed`. Houston builds it from the
commands it executed and the files its tools changed. The agent can't write it, so
it is the thing to compare the agent's own summary against: if the reply says the
tests pass and the receipt says no tests ran, believe the receipt.

- **What it lists.** Commands that test, typecheck, build, lint, install, start a
  server, or send an HTTP request to a local server, each with its real exit code
  and, for most test runners (pytest, vitest, jest, mocha, node:test, cargo,
  unittest), the passed and failed counts from the runner's own summary. Other
  commands (`ls`, `git status`) are only counted. Click the line to expand it.
- **Browser checks.** A page the agent looked at with view_localhost is listed with
  how its steps went. It counts as passed only when a check of the page
  (`expect_text` or `wait_for`) passed after the last click or keypress: clicking
  through a flow shows it didn't break, not that it did the right thing.
- **Also listed.** Commands a writable subagent ran (marked with who ran them), your
  verify command when Houston runs it at the end of a turn, and how a command started
  in the background ended (or that it is still running, for a dev server). A check
  that ran before the turn's last file change says so, since it may not cover the
  final code.
- **Todo items it can't back.** When the agent marks a todo done that says a check
  ran ("Backend tests with pytest", "Verify the build") and no passing run of that
  check is recorded this turn, the receipt lists it as marked done with nothing
  recorded, and the agent is told at the moment it marks it. The list itself is left
  as the agent wrote it. Items about writing something ("Write tests for the API")
  never need a run behind them.
- **An accepted plan's progress.** After you accept a plan, each turn that works on
  it shows how far along it is, counting every turn since you accepted it: "plan: 9
  of 11 files, 1 of 3 checks passed", with the files it named that nothing has
  changed yet and each of its checks (passed, ran with nothing passing, not run yet).
  This holds across turns, so "finish the planned implementation" two turns later
  picks up where it was. It says "plan complete" once, and stops when a newer plan
  replaces it or the chat moves on to other work. If you ask to skip the checks,
  they show as skipped.
- **Outcomes it can't tell.** An HTTP request made without `curl -f` (so an error
  page still exits 0), a test whose exit code is hidden by what follows it
  (`pytest | tail`, `pytest; echo done`), or a page that loaded with nothing on it
  checked is shown as unknown rather than passed.
- **Where it lives.** It is saved with the conversation and shown again when you
  reopen it. It never goes to the model. Importing a conversation doesn't bring
  receipts along, since Houston didn't record those runs. The terminal client and
  headless mode print it too, `--json` includes it in the result line, and an HTML
  export shows it under the turn.
- **What it costs.** Nothing: no extra model calls and no extra commands. It only
  reads what already ran.

## Diagrams and visuals in replies

In the desktop app, the agent can answer with pictures as well as text. A
` ```mermaid ` block in a reply (a flowchart, sequence, state, or entity diagram) is
drawn as a diagram, and an ` ```svg ` block as an image; each has a Rendered/Code
switch, so the source is always one click away. Diagrams follow the app's light or
dark theme, and one that doesn't parse shows the error above its source. Mermaid runs
in a separate hidden window that can't reach the network, never in the app itself,
and the result is shown as an image, so nothing in it can run.

Interactive visuals are off by default. Turn on "Run interactive visuals in the chat"
in Settings (Appearance) to let an ` ```html visual ` block run: a small chart with
controls or a widget to try, in a sandboxed frame with no access to the app, no
network, no forms, popups, or navigation, and its own process, so a misbehaving one
can't freeze the chat. With it on, plain ` ```html ` blocks also get a Preview button.
At most three run at once; the rest wait behind a Run button.

In the terminal these blocks stay code, with a line pointing at the desktop app.

## Editing files while it works

You can keep working in your own editor while a turn runs. Before the agent
overwrites or edits a file, Houston checks two things: that the agent has read the
file in this conversation, and that the file still says what the agent last saw. If
you changed it in the meantime (or a shell command, a formatter, or a subagent did),
the write is refused and the agent reads the file again first, so your change is
never replaced by an older copy. Creating a new file needs no read. Reads carry over
between messages of one conversation for files nobody has changed since; after the
app restarts, or once a read has been compacted out of the conversation, the agent
reads a file again before changing it. Changes Houston makes on the agent's behalf
right after a write (format-on-save, a PostToolUse hook) don't count as yours.

The agent sees files with line numbers, so it can cite exact lines and page through
a large file by them. When an edit lands somewhere the agent didn't spell out
exactly (its snippet had drifted from the file, or carried copied line numbers), the
result shows the edited lines so it can check them. An edit whose snippet matches
nothing points the agent at the closest part of the file instead of only failing.

## Typing while it works (steering)

You do not have to wait for a turn to finish before saying the next thing. Type
while the agent works: what you type appears on the status line, and `Enter` sends
it.

It goes to the turn that is running. The agent reads it before its next step, so
"no, use YAML instead" changes what happens next rather than arriving after the
work is done. Houston prints `· steering: …` at the moment the message actually
reaches the model, not when you pressed `Enter`. Until then it has changed
nothing, and saying otherwise would be a lie. The message is an ordinary part of
the conversation, so it appears in the transcript and is remembered like anything
else you said.

This is the middle ground between the two bad options. Interrupting throws away the
turn's work and its context; waiting lets the agent keep building on the wrong
thing for however many steps are left.

In the desktop app, `Enter` steers the running turn the same way, and `⌘+Enter`
(`Ctrl+Enter` on Windows and Linux) queues the message instead, to be sent as the next
turn when this one finishes. The message box says so while a run is going, the Steer
button sits where Send normally is with Queue beside it, and a steered message is
labelled **Steered** in the transcript. A `/command` or a `# rule` typed mid-run is run
or saved, never steered.

If the turn finishes before your message lands (you typed it as the agent was
wrapping up), nothing is lost: it is sent as the next message automatically, with
no second `Enter`. Several such messages go together as one.

- `Esc` clears what you have typed. On an empty line, `Esc` stops the run (so does
  `Ctrl-C`).
- Stopping a run also drops anything still waiting: those messages were follow-ups
  to work you just threw away.
- A slash command typed while the agent works is run as a command, never sent to
  the model as text. In the terminal it runs once the turn ends. In the desktop app
  it runs right away (switching the approval mode applies to the running turn),
  except `/compact`, which waits until the turn ends.

## How long a turn runs

A turn has a step budget (40 by default; each model reply is one step). Near the
end the agent is told to wrap up, so it finishes the edit in hand or summarizes
what is left instead of being cut off, and you say "continue" to pick it up.

A turn that is plainly making progress doesn't have to stop there. If several of
its recent steps edited files successfully, or most of them turned up something new
(a file it hadn't read, a search or command it hadn't run), and it hasn't been caught
looping, it gets another round of steps instead of the wrap-up, and the transcript
says so. Going back over calls it already made doesn't count. This keeps going up to
a hard limit (200 steps by default), so a big job such as scaffolding a new project,
or a long debugging session, finishes in one go. Stopping the run works as usual at
any point. Settings > Loop control has the per-turn step count, the
keep-going-while-productive switch, and the hard limit. If you had already set your
own step count, it stays a hard stop until you turn the switch on.

A single reply also has an output limit. When a reply is cut off there, the agent
picks it up exactly where it stopped (up to three times in a row) instead of leaving
a half-finished answer, and the transcript notes each time. A tool call the limit cut
off is never run on partial input: it is answered as "not run" and the agent redoes
the work in smaller pieces. Either way, later replies in the turn ask for the model's
full output allowance where Houston knows it.

## Undoing a turn, and seeing what changed

- **`/undo`** puts back the files the last turn changed; **`/redo`** re-applies
  them. Houston snapshots every write before it happens, so this needs nothing set
  up. It is most useful under auto-approve modes, where edits land without a
  prompt: "that was wrong, put it back" is one word rather than a hand revert.
- **`/changes`** (also `/diff`) summarizes everything different in the working
  tree: each file with its status and how many lines it gained and lost, plus a
  total. The natural question after a long autonomous run.
- **Shipping changes (desktop app).** When the working tree has changes, the bar
  above the composer and the Changes panel offer one button that fits the
  repository: **Create PR** when it has commits and a GitHub remote (github.com, or
  a GitHub Enterprise host your `gh` is signed in to), **Publish to
  GitHub** when it has no remote yet (commit, create the repository, push), **Push
  first commit** when a remote exists but nothing is committed, and **Commit &
  push** for a remote that isn't on GitHub. Each hands the work to the agent as a
  normal turn, so every git and network step goes through your approvals.
- **Prompts Houston writes for you.** `/review`, `/agent`, the shipping buttons, and
  a session another chat handed off each send the agent a detailed prompt. The chat
  shows what you did (for example "/review" or "Create PR") instead of that prompt;
  open **Instructions sent to the agent** under it to read the exact text. The
  terminal prints a one-line summary in its place.

`/undo` covers the last turn's file writes only. It does not undo shell commands,
and it does not touch git history.

## Being told when it needs you

A long run can block on an approval, a question, or a plan, and then it is just
waiting. So the interactive terminal tells you:

- **The tab title** always reflects the state: what it is doing, that it needs
  approval, or that it is idle, with the project name so several sessions are
  tellable apart. This is ambient, never interruptive.
- **A bell and a notification** fire when a run needs you or finishes, but only
  when you have switched away from the terminal (Houston asks the terminal to
  report focus, so it can tell). If your terminal does not report focus, they
  fire either way rather than staying silent.

Only the moments that matter ring: needing approval, needing an answer, a plan
awaiting a verdict, an error, a finished turn, and a pull request opened or
merged. Ordinary progress is quiet. Stopping a run yourself never pings you (you
are obviously there). Turning off notifications in Settings turns off the bell
and notification here too; the title still updates.

Notifications use the terminal's own channel, so they need no extra tools. Not
every terminal supports them; the bell works everywhere.

## How hard the model thinks (/reasoning)

`/reasoning` shows the current thinking effort; `/reasoning high` (or `off`, `low`,
`medium`, `xhigh`) sets it. It applies to every model that supports reasoning, and
Houston says so plainly when the model you are on does not, since a setting that
silently does nothing looks like a bug rather than a fact about the model.

It starts at `high`, since coding and long multi-step work gain the most from
deeper thinking. More thinking costs more tokens and takes longer per step, so
turn it down (`/reasoning medium`, `low`, or `off`) for quick questions or to save
money. The desktop app has the same setting in the reasoning menu next to the
model picker.

## What a session cost (/cost)

`/cost` breaks the session down by model: tokens in and out, how many of the
input tokens were served from the prompt cache, and the dollar cost, with a total
when more than one model billed. Subagents and reviews often run on a different
(cheaper) model, and they are listed separately rather than folded into the main
one.

The cached count is worth watching on a long session: those tokens are real
context, but they bill far below the base input rate, so a big number there is
why a long conversation costs less than its token count suggests.

## Version and updates

The interactive terminal shows its version in the banner at startup, and
`houston -v` prints it. Once a day it quietly checks whether a newer release
exists and, if so, prints one line with the link the next time it draws a prompt.
It never blocks startup, and a failed check is silent. To turn the check off, set
`HOUSTON_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER`). The desktop app updates
itself separately.

## Checking your setup (/doctor)

`/doctor` reports what Houston can see: the version (and whether a newer one is
out), Node and platform, the active model and every provider's key status,
whether the shell sandbox is actually enforced on this host, which external tools
(`git`, `gh`, `rg`) are on PATH, and each MCP server's connection state. In the
terminal it also reports the terminal's size and color support. Each row is marked
healthy, worth knowing, or broken, and anything not healthy comes with what to do
about it. It runs in both the desktop app and the terminal.

It answers the questions that used to need source-reading or guesswork, notably
"is my shell really sandboxed here?" and "why did setting my API key change
nothing?" (an environment variable silently outranks a stored key; `/doctor`
names it).

## Running your own commands (!)

Type `!` followed by a command to run it in your own shell, without leaving the
session: `!git status`, `!npm test`. Output streams as it happens.

What you ran and what it printed is also added to the conversation, so you can
follow it with "now fix those failures" and the agent knows what you saw, with
nothing to paste back. Long output is trimmed to its last lines (where errors
usually are).

This is **your** shell, not the agent's: it runs unsandboxed, in your project
folder, with your environment, exactly as if you had typed it in another window.
The sandbox exists to confine the agent, which can be steered by instructions
hidden in the content it reads; a command you typed yourself is your own
decision. `!` alone, or `!` in the middle of a line, is ordinary text.

## Approval modes and permissions

Approval is layered. From most to least restrictive:

- **Plan mode:** read-only. The agent researches and proposes a plan; writes and
  shell commands are blocked. It presents the plan for the user to accept,
  request changes, or reject. The plan lists the checks it will run, and under them
  Houston shows whether those checks can run on this machine: whether the runtimes
  are installed, whether the dependencies are, and whether shell commands can reach
  the network to install them (for example, "choose Allow for run on the install
  command"). Houston works this out from the machine without running anything, and
  tells the agent about any problem when you accept, so it can say a check couldn't
  run instead of claiming it.
- **Ask every time:** every edit and command needs a click.
- **Auto-approve edits:** file edits go through automatically; shell commands
  still ask.
- **Full auto:** edits and (sandboxed) commands run without asking. A few controls
  still hold even here, because the sandbox can read your whole filesystem: network
  egress is granted **per destination** (approving a fetch to one host does not open
  egress to another), the first shell command pauses once for a **shell-network
  consent** so blanket outbound access is never automatic (declining runs commands
  offline), a shell command that **names a path outside the project**, quoted or
  not, asks first (`/dev/null` and the temp directory the sandbox can already write
  to don't count),
  and **reading a credential file** (a `.env`, a private key, `.aws/credentials`
  and the like) prompts even here, since reads otherwise never do. "Allow for run" on
  that prompt stops it asking about credential reads for the rest of the conversation,
  and an `allow` permission rule opts a path in permanently. **Changing a credential
  file** prompts too: a file edit that writes one, or a shell command that redirects
  into, copies over, edits in place, or removes one (`> .env`, `cp .env.example .env`,
  `sed -i … .env`, `rm .env`). Templates such as `.env.example` don't count.

**Throwing away work** asks in every mode, full auto included. The sandbox keeps
commands inside the project, but the project is what these destroy, and undo doesn't
cover shell commands: `git reset --hard`, a forced `git clean`, `git checkout -- .`
or `git restore` of your changes, `rm -r` of anything but build output and
dependencies (`node_modules`, `dist`, `build`, `target`, `__pycache__` and the like
are fine), `find … -delete`, deleting a branch or a stash, rewriting history, and a
forced or deleting `git push`. Quoting a word, splitting it across lines, or running
it through `bash -c` doesn't hide one. "Allow for run" doesn't stop these asking; an
`allow` permission rule for that exact command does (the "Always allow" choice on the
prompt saves one).

**Which mode a new install starts in.** Where the sandbox confines shell commands
(macOS, and Linux with bubblewrap), a new install starts in **Full auto**; where it
can't (Windows, or Linux without bubblewrap), every command would run unconfined, so
it starts in **Ask every time**. An existing install keeps the mode it last used. The
desktop app and the terminal start in the same saved mode; `--approval` or
`--full-auto` overrides it for one terminal session, and a headless run starts in plan
unless told otherwise.

**Reading the diff.** A file edit shows a real diff before you approve it: the
changed part with a few lines of context (long untouched stretches are folded away
with a note saying how many), line numbers in the gutter, the changed words picked
out inside a modified line, and the code syntax-coloured.

On any single tool call the user can approve once, deny, **allow for the run**
(auto-approve that kind of tool for the rest of the conversation, or, for a
network call, just that one destination), or **always allow / always deny**
(saves a permission rule so the choice persists). File edits show an inline
red/green diff before approval.

**Denying with a reason.** A refusal can carry guidance, and the agent is told
what it says, so "no, and here is what to do instead" lands in the same step
instead of needing a follow-up message. In the desktop app, type it in the box
under the approval buttons (Enter denies with that reason). In the terminal, pick
"Deny with a reason…", or just type the reason at the approval prompt: anything
that is not one of the shortcut keys is read as a denial plus that explanation.
The terminal's approval keys are `y` allow, `n` deny, `a` allow for the run, `!`
always allow, `x` always deny.

Stopping a run while an approval is waiting is recorded as an interruption, not
as a refusal, so the agent is not told the user rejected something they simply
never answered.

**Switching mode.** In the terminal, `Shift-Tab` steps through the modes, from
most restrictive to least and back around to plan. It works while the agent is
working too, and applies to the run in progress: if a turn stops for an approval
you would rather not keep answering, loosen the mode and the same turn carries on
under it, rather than having to interrupt the work you were trying to unblock. The
mode is shown next to the spinner while a turn runs, and on the status line above
the composer the rest of the time. `/approval <mode>` sets one directly.

**Permission rules** (Settings) are finer-grained than the mode: `allow`,
`deny`, or `ask`, matched on the tool plus a glob over its target, e.g. allow
`run_shell` matching `git *`, deny anything matching `*rm -rf*`, always ask
before `write_file` under `src/secret/**`. Rules are checked before the mode and
the first match wins. Matching normalizes the target so a rule cannot be dodged
by respelling it: a file rule is resolved and anchored to the workspace (so
`src/*` covers the same file written as an absolute path, and a relative climb
like `src/../../etc/passwd` does not slip past it), a URL rule is
case-insensitive on scheme and host, and a shell rule sees through quoting,
backslash escapes, and bash's `$'...'` escapes (so `deny *rm -rf*` still fires on
`"rm" -rf`, `r\m -rf`, or `$'\x72m' -rf`). A line that ends in a backslash continues
onto the next, as in bash, so a deny also fires on `rm` split across two lines, and
an allow must cover the joined command. An allow rule sees through quoting only
where it changes nothing (`"git" status` is `git status`): a quoted or escaped `*`,
`~`, `$`, space, or `>` is not the bare one, since the shell treats them
differently. Allowing `rm '*'` (one file named `*`) never allows `rm *`, and
allowing `rm -rf '~'` (or `rm -rf $'\x7e'`) never allows `rm -rf ~`. An empty
quoted argument counts as one: allowing `'' rm -rf /` (which runs nothing) never
allows `rm -rf /`. Quoted or escaped whitespace is part of an argument, as in bash,
so an allow keeps it as written: allowing `rm 'my  file'` (two spaces) never allows
`rm 'my file'`, and allowing `find . -delete \ ` (find gets a lone space and stops)
never allows `find . -delete`. Spacing outside quotes doesn't matter. A rule an
earlier version of Houston saved with that whitespace collapsed allows what its text
says; one that ends in a lone backslash matches nothing, and **Clean up rules**
removes it.
An `apply_patch` call is checked against every file it adds, changes, deletes, or
moves to: one denied file denies the whole patch, one `ask` file asks, and an
`allow` covers it only when every file is allowed. "Always allow" or "Always deny"
on a patch saves one rule per file.

A rule marked **Exact** matches only its one target: `*` is an ordinary
character and a folder does not cover the files inside it. **Always allow** on a
file, URL, or search saves an exact rule, so approving a write to a file named
`*`, or to a folder path, allows that path and nothing else. On a shell command
it saves a command prefix instead, such as `npm install`. A command it can't
shorten to a prefix is saved whole, and exact when it holds `*`, so approving
`rm *` never allows `rm -rf ~`. A `cd` into the project needs no rule (an allowed
`npm install` also covers `cd src && npm install`), so it is left out. Any other
change of directory, such as `cd -`, `popd`, `cd $DIR`, or a `cd` out of the
project, still asks, and is saved whole and exact. A shell rule like `rm *` saved
by an earlier version is still a pattern: tick **Exact** on it to narrow it.
**Always deny** saves a regular pattern, which can only be broader than the call
it blocked.

**Project guardrails.** A repo can ship a `.houston/settings.json` with its own
`deny` / `ask` rules, checked before the user's global rules. Those guardrails
always apply and can only *tighten*, so cloning an untrusted repo can never
auto-approve actions.

**Trusted folders.** The same project file may also define `allow` rules,
`hooks`, and `mcpServers`. Those ELEVATE (they auto-approve matching actions or
run processes as you), so Houston ignores them until you explicitly trust the
folder: the desktop app shows a banner above the composer, and the interactive
terminal asks at session start (Trust / Not now / Never). Your decision is bound
to a fingerprint of that elevating config; if it later changes (say a pull adds
a hook), the folder drops back to untrusted and Houston asks again. Headless
runs never prompt and simply note when an untrusted folder's extra config is
being ignored. Trusted project `allow` rules sit BELOW your own rules (they fill
gaps, never override you), project hooks run after yours, and project MCP
servers appear namespaced as `mcp__proj-<id>__<tool>`.

Decisions are reviewable: Settings, *Workspace*, *Trusted folders* lists every
folder you answered for (trusted or never) with a Forget button, and `/trust`
in the terminal shows the current folder's state (`/trust forget` clears the
decision and asks again on the spot). Forgetting is how you reverse a "Never"
or retire a stale "Trust".

**Managed policy.** On a managed device an administrator can ship a machine-wide
`managed-settings.json` with `deny` / `ask` rules that outrank both project
guardrails and every user's own rules. It too can only tighten, and lives in a
root-owned location the user cannot edit.

## Skills

A skill is a reusable instruction bundle at `.houston/skills/<name>/SKILL.md`,
with front-matter `name` and `description` and a body of instructions. Only the
name and description are shown to the agent up front (cheap); the agent loads the
full body on demand by calling the `skill` tool when a task matches. This is
progressive disclosure: skills stay out of the way until they are needed. Houston
also ships two built-in skills: this guide as `houston-guide`, and, in the desktop
app, `render-ui`, which the agent follows when you ask to see how something looks or
will look (screenshots of the running app, or a mockup, shown with `show_images`).

A skill can bundle more than its SKILL.md. Any other files in the skill directory
(a `references/` folder, a template, a helper script) are listed at the end of the
`skill` response, so the agent knows they are there and can read or run them with
the file tools as the instructions direct. The SKILL.md body stays the first level
of disclosure; the bundled files are the second, pulled in only when a task needs
them.

## Custom subagents

Drop a Markdown file in `.houston/agents/<name>.md` to define a specialized
subagent: front-matter `description` plus a system-prompt body. The main agent
dispatches it by name with `dispatch_agent`, and it works in its own fresh
context and reports back, keeping the main thread clean. An optional front-matter
`tools:` list narrows which tools it may use, and an optional `model:` pins the
agent to a (usually cheaper) sibling model from the current provider (unknown
ids fall back to the chat's model). By default a subagent is read-only (it cannot
edit files or run commands); a subagent marked `write: true` gets a writable tier
and is dispatched with `dispatch_writable_agent`, which is approval-gated because
it grants write access: one approval covers the whole delegated task's local
actions, confined to the project. Your permission rules still apply inside
either tier: a `deny` (including a managed-policy or project guardrail one)
refuses the subagent's call outright, and an `ask` rule, a credential-file read
(a `.env`, a private key), or a shell command that names a path outside the project
asks you first, exactly as for the main agent. Either tier can also reach the web with
`web_fetch` and `web_search`, and every network request first asks you for
approval, per destination, exactly like the main agent's own network calls (a
denial comes back to the subagent as its tool result). A subagent's shell
commands never get network access. On a host without an OS-enforced sandbox
(e.g. Windows), each shell command a writable subagent runs would run unconfined,
so it asks for its own approval first too. Tokens a subagent spends roll into the
conversation's usage meter, priced at the model the subagent actually ran on.

While a subagent works, its dispatch row shows live progress (turn counter plus
what it is doing), in every client. Each report ends with an id like `ag1`: the
main agent can pass it back as `resume` to send a follow-up into that subagent's
context instead of re-dispatching from scratch (ids last for the app session). A
dispatch can also pass `model` to run one-off legwork on a cheaper sibling model.
Subagents can fan out one level themselves: a dispatched agent may dispatch its
own nested read-only researchers (never writable, and no deeper).

**Running one yourself.** `/agent <name> <task>` hands a job to one of your agents
directly, instead of describing it in prose and hoping the right one gets picked.
It works in both the desktop app and the terminal; `/agent` alone (or `/agents`)
lists them.

## Spawn separate sessions

Where a subagent reports back into the current turn, `spawn_session` spins off a
*separate* chat: the agent hands it a task, optionally on its own git branch and
worktree, and sets it running in the background. It appears in the sidebar with a
live indicator, seeded with the handed-off context. A spawned session inherits
the current approval policy, so it is never more permissive than the chat that
spawned it. In the TUI and headless CLI, spawned sessions run too: they execute
non-interactively (anything needing an approval is declined automatically) and
persist as ordinary conversations you can open later with `/resume` or
`--resume <id>`; a one-shot headless run waits for its spawned sessions before
exiting.

In the sidebar, a spawned session sits under the chat that started it (the arrow
beside the parent folds them away, a folded parent says how many are still
running, and Houston remembers what you folded across restarts). A session you pin or move into a group stays where you put it. Its
"Handoff from …" banner links back to the parent chat.

A spawned session starts fresh with its prompt, or, with context "fork", with a
copy of the spawning chat so far. When it finishes, the chat that started it gets
a short report (title, whether it worked, the start of its answer) as a Houston
note at the start of its next turn, and you see a notice in the transcript.

## Proposed sessions

When the agent spots parallel work you didn't ask for (a fix noticed in passing,
the natural follow-up), it proposes it with `propose_session` instead of starting
it. The desktop app shows a card: **Start session** runs it as its own chat (on
its own git worktree when the project is a repository, under your current approval
policy), **Do it here** asks for it in this chat instead (queued if a turn is
running), and **Dismiss** declines it. Nothing runs until you choose. A turn can
propose at most three sessions, and never the same title twice in one chat.

In the terminal, `/proposals` lists the chat's proposals; `/proposals start <n>`,
`/proposals here <n>`, and `/proposals dismiss <n>` act on one.

## Side chat (/btw)

The side chat answers a quick question about the open chat without adding
anything to it. Open it from the titlebar (or the command palette); it sees the
chat so far and can read the project, but it cannot edit files, run commands, or
reach the network, and it works while the main chat's turn is still running.
**Send to main** puts an exchange into the main chat as a message (queued if a
turn is running), and **Continue in new chat** forks the chat with the exchange as
a draft. Its tokens count toward the chat's cost.

Each chat has one side chat, kept with the chat: closing the panel, switching to
another chat, a plan review taking over the panel, or restarting Houston never
loses it, and an answer still coming in keeps going and shows up when you come
back. Before each follow-up it catches up on what the main chat said since the
last answer. **New side chat** (the + in its header) clears it and starts over.

In the terminal, `/btw <question>` asks the same chat's side chat (shared with the
desktop app's panel), and `/btw clear` starts it over.

## Watching work you sent off (/spawned)

When the agent hands a task to a separate session (see "Spawn separate sessions"),
that session runs in the background, often on its own branch and worktree.
`/spawned` lists what this chat started: which are still running, which finished,
and what branch each one is on. Pick a number to open one.

Opening a session that is still running is fine, and does not stop it: you see its
work so far while it keeps going. That is how you check on parallel work without
interrupting it.

(`/resume` is the different one: it reopens any saved chat in this folder,
whether or not this session started it.)

## Scheduled runs

The agent can schedule recurring (or one-time) background runs with
`schedule_run`: say "every morning at 9, run the tests and summarize failures"
and it stores a schedule; at each occurrence a fresh session starts with the
stored prompt, under the approval policy of the chat that created it. Specs:
`every <N>m|h|d` (minimum 5 minutes), `daily at HH:MM`, `weekdays at HH:MM`,
`weekly on <day> at HH:MM`, or `once at YYYY-MM-DD HH:MM` (local time).
`list_scheduled_runs` shows what's configured (with next/last fire times);
`cancel_scheduled_run` removes one. Creating or cancelling a schedule is
approval-gated. Schedules persist across restarts and fire while Houston (the
desktop app or the TUI) is running. This is an in-app scheduler, not OS cron;
an occurrence missed while Houston was closed fires once at the next launch.

## Review and multi-step tools

- **`review_changes` (or `/review`)** reviews uncommitted changes for
  correctness, security, and quality. It runs an independent read-only reviewer
  per dimension, each in a fresh context, then a skeptical verifier that
  re-checks every candidate against the real code and drops false positives, and
  reports the confirmed findings. Findings show up under the review as soon as
  each reviewer reports them, marked unverified, and update in place as the
  verifier confirms or rejects them; once the review ends, rejected findings fold
  into a "dropped as false positives" line you can expand. Click a finding to see
  why it matters and the suggested fix. Scope it to a `base` branch or specific
  `paths`, raise `effort` to `high` to verify each finding with several
  independent skeptics, or pass `model` to run the reviewers and verifiers on a
  cheaper sibling model.
- **`todo_write`** keeps a task list for multi-step work, rendered live in the
  transcript.
- **`pr_sweep`** tracks batch pull-request work (author new PRs from a task list,
  or process a batch of existing open PRs).
- **`show_images`** shows you image files the agent produced, such as screenshots
  of an app or rendered mockups. In the desktop app they appear as a captioned
  gallery: click any image to open it full size, step through the set with the
  arrow keys, compare it with a "before" image using a slider when the agent paired
  one, copy it, save it, show it in the Files panel, or open the file in its
  default app. In the terminal each image is a clickable link to its file. It only
  reads image files (PNG, JPEG, GIF, or WebP, up to 5 MB each, 12 per gallery)
  inside the project, so it never asks for approval. Images go to the model scaled
  down to at most 1568 pixels on their long side; the chat keeps the full-size
  originals.
- **`render_mockup`** (desktop app) turns an HTML mockup file in the project into
  screenshots without a dev server, in the sizes and themes asked for (desktop,
  tablet, or mobile, light or dark, or a custom size), and shows them as a gallery
  marked "Mockup from code". The page runs in a hidden, locked-down browser: it can
  load its own files from the project folder, but nothing from the network or from
  elsewhere on your computer. It writes nothing, so it never asks for approval.
- **`view_localhost`** (desktop app) loads a page from a dev server running on
  your computer in a hidden browser and shows the agent a screenshot plus the
  page's visible text and console output. It can also run steps first (fill a
  field, click or double-click, press a key such as Enter or Escape, wait for an
  element, check that some text is or isn't shown), so the agent can try a flow
  such as logging in or submitting a form and get a pass or fail for each step.
  It can also capture the page in several viewports or color schemes in one call
  (desktop, tablet, or mobile, light or dark, or the full page height), shown as a
  gallery marked "Running app"; steps then run with only one of them.
  Each call starts from a fresh page load, so a flow runs within one call. Text
  typed into a password field is never shown back to the agent. Every call asks
  for approval. A call with steps
  is approved separately from plain views, and the approval lists each step
  (never the text being typed). Steps can't download files, upload files, or use
  your camera, microphone, or location, and the page can't leave localhost.

## Hooks

Hooks (Settings, *Hooks*) run your own shell commands at set points in the
agent loop. Each hook names an event and, for the tool events, a matcher glob
on the tool name (the other events match only an empty or `*` matcher):

- **PreToolUse**: before a tool call runs. Can block the call, approve it
  (skipping the approval prompt), or rewrite its arguments.
- **PostToolUse**: after a tool call. The hook's output is appended to the
  tool result so the agent sees it (e.g. auto-format after every edit, or run
  tests after a write).
- **UserPromptSubmit**: when you submit a message, before the turn runs. Can
  block the prompt or inject extra context.
- **SessionStart**: once when a run begins. Injected context is appended to
  the system prompt.
- **Stop**: when the agent would end its turn. Blocking forces another turn
  with the reason fed back (e.g. "run the tests before you stop"), bounded so
  a hook cannot keep the agent alive forever.
- **PreCompact**: before the conversation is compacted. Injected context is
  folded into the material being summarized, so it survives compaction.

The simplest contract is the exit code: a non-zero exit blocks the blocking
events (PreToolUse, UserPromptSubmit, Stop), and plain stdout/stderr is fed
back to the agent as feedback. For finer control, a hook can print a single
JSON object on stdout:

- `decision`: `"block"` vetoes the action even on a zero exit; `"approve"`
  (PreToolUse only) skips the approval prompt. A block always wins over an
  approve.
- `reason`: a human-readable explanation, fed back to the agent (and shown
  with a block).
- `additionalContext`: extra context injected where the event fires: the tool
  result (PreToolUse), your message (UserPromptSubmit), the system prompt
  (SessionStart), or the material being summarized (PreCompact).
- `updatedInput` (PreToolUse only): replacement arguments the tool runs with.
  A rewrite that fails the tool's schema fails the call rather than falling
  back to the original arguments. Rewritten arguments are re-matched against
  your permission rules, so the approval decision is made on what will
  actually run: a rewrite that lands on a deny rule is refused outright, even
  if the hook also approved. A hook can tighten policy, but it can never
  loosen a managed or project deny.
- `systemMessage`: a note for you rather than the agent; it is never added to
  the model's context.

When several hooks match, they run in order; any block wins, and the last
rewrite wins. Hooks run in the same project sandbox as `run_shell` (no
network). Context arrives in environment variables: `$HOUSTON_HOOK_EVENT`,
`$HOUSTON_TOOL_NAME`, and `$HOUSTON_TOOL_INPUT`, plus `$HOUSTON_TOOL_RESULT`
(PostToolUse) and `$HOUSTON_USER_PROMPT` (UserPromptSubmit). A payload over
16 KB (a large write, a long tool output, a long pasted prompt) is too big for an
environment variable, so it is written to a private temp file instead: the
variable is left unset and `$HOUSTON_TOOL_INPUT_FILE`, `$HOUSTON_TOOL_RESULT_FILE`,
or `$HOUSTON_USER_PROMPT_FILE` holds the file's path. A hook that may see large
payloads should read whichever of the two is set. The file is removed once the
hooks finish. A hook that can't be started counts as a failed hook, so a
PreToolUse or UserPromptSubmit hook that can't run blocks rather than lets the
action through.

## Plugins

Drop a JS file in `.houston/plugins/` to register *observational* lifecycle
hooks: `houston.on('onToolStart' | 'onToolResult' | 'onUserMessage', fn)`, for
logging, metrics, or notifications. Plugins are local trusted files (the same
trust model as hooks, agents, and skills) and only run when the user has opted
into project plugins for that project. Each runs in an isolated context with no
`require`, `process`, or network; a plugin cannot block or alter a call (use a
PreToolUse shell hook for that), and a throwing or slow plugin is caught and
ignored.

## MCP servers

Connect Model Context Protocol servers in Settings: a local **stdio** process or
a remote **HTTP** (streamable) or **SSE** endpoint. Their tools are offered to
the agent namespaced as `mcp__<id>__<tool>` and always require approval. When
many MCP tools are connected, Houston loads their schemas lazily: above a
threshold the agent gets a compact catalog plus a `find_tools` meta-tool and
pulls in only the tool definitions it needs, instead of sending every schema on
every request.

**Authentication.** Remote servers take custom headers (e.g. a static
`Authorization: Bearer` token), or **OAuth** for servers that require a sign-in:
click *Sign in (OAuth)* on the server in Settings (desktop) or run
`/mcp login <n>` (terminal). Houston discovers the server's authorization
server, registers itself as an OAuth client automatically, and opens the browser
to authorize; tokens are stored encrypted, sent as the bearer on every
connection, and refreshed automatically when they expire. *Sign out* (or
`/mcp logout <n>`) forgets them. An explicit Authorization header, when set,
takes precedence over OAuth tokens.

**Local (stdio) servers** can be given a working directory and environment
variables (Settings, or the `/mcp add` prompts). The spawned process gets a
credential-stripped base environment, so a token the server needs must be listed
explicitly; env values are secrets and are stored encrypted, like header values.

**Resources and prompts.** When a server exposes MCP resources or prompt
templates, the agent gets `mcp_list_resources`/`mcp_read_resource` and
`mcp_list_prompts`/`mcp_get_prompt` meta-tools to discover and fetch them.
Houston also honors server `list_changed` notifications (tools, resources, and
prompts refresh live), keeps long tool calls alive while the server reports
progress, and caps any single MCP result so a runaway server cannot flood the
context window. `/mcp tools <n>` lists exactly which tools a server exposes: a
count tells you it works, the names tell you what you just handed the agent. `/mcp` in the terminal
and the Settings panel show each server's
live connection status: connected with a tool count, needs sign-in, or the
connect error.

**Server questions (elicitation).** A server can ask for input in the middle of
a tool call (for example a region, a project name, or a confirmation). Houston
shows the request as a small form naming the server, with typed fields and
Submit / Decline: your answer goes to that MCP server, not to the model. In the
terminal the same request becomes an inline prompt (decline with `n`); in a
headless or background run it is declined automatically so nothing ever hangs
waiting for a user who is not there, and the server proceeds along its
no-answer path. Stopping the run cancels any open request.

## Shell sandbox and network

Shell commands run under the host OS sandbox where one exists, confined to the
project directory: writes outside the project are blocked, and network access is
off by default.

- **macOS:** Seatbelt (`sandbox-exec`).
- **Linux:** bubblewrap (an unprivileged user namespace), when available.
- **Windows:** no broadly-available equivalent, so shell commands run unconfined;
  Houston reports them as not sandboxed and never silently auto-approves one.

The structured file tools stay confined to the project on every platform.
Network from `run_shell` is *gated*, not permanently off, and it is no longer
implied by full auto: the sandbox can read your whole filesystem, so blanket
outbound access plus full auto would be a one-command read-and-exfiltrate. Shell
reaches the network only after a conscious per-run grant, either the one-time
**shell-network consent** (full auto) or "Allow for run" on a shell command
(ask / auto-edit). Plain "Allow" and "Always allow" run that one command offline,
and until the run has the grant, each shell approval prompt says so. A command
that needs the network (cloning, installing dependencies, `gh`, `curl`) is not
impossible, it just needs that grant; declining runs the command offline instead
of blocking it. A headless run (`-p`) has no prompt to grant it from, so the grant
is a flag: `--allow-shell-network` lets shell commands reach the network for that
run under any policy, and is not remembered for the next one. Without it, shell
runs offline, except under `--full-auto`, where `--on-approval allow` (its
default) also answers the shell-network consent. `--on-approval allow` alone never
grants it under ask or auto-edit, since it approves each command the way plain
"Allow" does. Offline, npm, pip, and cargo skip their usual retries, so an
install that needs the network fails in about a second instead of a minute or
more. Package-manager caches (npm, pip, yarn) are auto-redirected to a writable
temp dir, so dependency installs need no cache workaround once network is on. On
macOS, Python's bytecode cache goes there too, since the system `python3` keeps it
under `~/Library/Caches`, which the sandbox can't write. **Additional folders**
(Settings) can be added to the file tools' allowed roots and the shell sandbox to
work across more than one repo.

**Finding your toolchain.** An app opened from the Dock doesn't read your shell
startup files, so Houston adds the usual places runtimes live to the shell's PATH:
Homebrew, nvm's default Node, fnm, Volta, mise, asdf, pyenv, rbenv, and the
per-user bin dirs of Rust, Go, Bun, and Deno. A sandboxed command may stop the
processes it started (build tools do this with their workers), but nothing outside
its own sandbox.

**When a runtime is missing.** If a command fails because Node.js, Python, Go,
Rust, Deno, or Bun isn't installed, the transcript says so and offers **Install**,
which runs the install command (for example `brew install node`) in a new tab of
the built-in terminal, outside the sandbox, so you can watch it and answer any
prompt; there's also a link to the official download page. The agent is told not
to attempt system installs itself and to wait for you rather than write code it
can't run. The terminal clients print the same install command.

**Egress allowlist.** Granted shell network is not unrestricted: on macOS and
Linux it is routed through a local proxy Houston controls, and the OS sandbox
blocks any direct connection, so the proxy is the only road out. The proxy
allows a destination only if its domain is on the egress allowlist: a built-in
set of development infrastructure (package registries such as npm, PyPI,
crates.io, RubyGems, Maven, Go; VCS hosts such as GitHub, GitLab, Bitbucket)
plus any domains added in Settings under **Sandbox egress**. Each entry also
covers its subdomains, a deny list wins over every allow, and edits apply
immediately, mid run. A refused destination fails with an `EGRESS_BLOCKED`
message naming the domain: that is policy, not an outage. Only HTTP(S) flows
through the proxy, so other protocols (for example SSH) are blocked under the
allowlist; use HTTPS remotes inside the sandbox, or switch the egress mode to
"All domains" (Settings) to restore unrestricted granted network. On Windows,
where no OS sandbox exists, the allowlist cannot be enforced. One Linux note:
each command runs in its own network namespace whenever shell network isn't
granted, and also under the allowlist, so a dev server started inside the sandbox
is reachable only from that same command: not from the Preview panel,
`view_localhost`, or later commands. Granting shell network with "All domains"
restores the shared network there. The agent is told this on Linux and checks web
apps with requests from the command that starts the server.

**Secret redaction.** Tool results, the transcript, and logs are scrubbed before
the model or the UI sees them: well-known token formats and this install's stored
secrets become `[redacted:…]`. A `NAME=value` line whose name marks it as a secret
(`SESSION_SECRET`, `ADMIN_PASSWORD`, `GITHUB_TOKEN`, `STRIPE_API_KEY`, and the like),
as `cat .env`, `env`, or `grep` prints it, keeps its name but shows the value as
`[redacted:env-secret]`. The agent therefore refers to such a value by variable and
file rather than repeating it, and a file write that would put a `[redacted:…]`
placeholder where a value goes is refused, so writing back a file it read cannot
replace the real secret with the placeholder.

**Credential masking on egress.** Houston's own network tools refuse to *send* a
credential: before a `web_fetch` or `web_search` leaves the machine, its URL or
query is scanned for a well-known token format or one of this install's stored
secret values, and the call is refused if one is present. This is the outbound
counterpart to the tool-result redactor (which scrubs secrets on the way back
in), so a prompt-injected agent cannot exfiltrate a key by pasting it into a
request. Note this covers Houston-mediated egress; a raw `curl` inside
`run_shell` is bounded by the shell-network consent above, not by masking.

**Untrusted content.** A fetched page is written by whoever runs the site, an
issue comment by whoever posted it, and an MCP result by whoever wrote what the
server relays. So Houston treats the text these tools return as data rather than
instructions, and it does not rely on the agent simply choosing to see it that
way. The tools covered are `web_fetch`, `web_search`, the GitHub tools that read
issue and pull request text (`gh_issue_view`, `gh_issue_list`, `gh_pr_view`,
`gh_pr_list`), the GitHub tools that read CI (`gh_run_view`, `gh_run_list`,
`gh_pr_checks`), and MCP tool results and resources. A pull request from a fork
runs the fork's own workflow files, so its author writes the job and step names
and everything its steps print to the log:

- **Fencing.** That text is wrapped in an `<untrusted-content-NONCE>` fence with
  a fresh random nonce per call, and the system prompt tells the agent that
  anything inside it is attacker-controlled. The nonce is what makes the fence
  hold: with a fixed tag, the text could close the fence itself and carry on as
  if it were trusted. Fields GitHub guarantees (an issue's number, state, author,
  and URL, or a CI run's id, outcome, and URL) stay outside the fence so the
  agent can rely on them, while titles, bodies, labels, branch names, diffs,
  workflow, job, step, and check names, and CI logs go inside. Each comment gets
  its own fence with its author shown outside it, so one comment cannot pass
  itself off as a maintainer's reply. The GitHub tools that write (opening,
  commenting, reviewing, merging, checking out, closing, reopening) report the
  outcome in a line Houston writes, plus the new item's URL, and fence everything
  `gh` printed, because its messages quote titles and branch names.
- **Isolation.** Content is scored for injection signals: text telling the
  reader to ignore prior instructions, a new persona, an instruction to send data
  to a URL, references to key material, text telling the reader to call Houston's
  own tools, characters hidden from a human reader. A web page or MCP result that
  looks like an attempt is not inlined at all. Instead a separate model call with
  no tools and no conversation history reads it and reports what it says, and
  only that report reaches the agent. The isolation is structural: there is
  nothing for the content to act through, and no earlier instructions to talk it
  out of. If that call fails, the content is withheld rather than passed through.
- **Warning.** GitHub text and web search results that look like an attempt stay
  inline and fenced, with a warning naming the signals. The agent needs an
  issue's exact repro steps or a pull request's exact diff to do its job, and a
  summary would not do. Search results are short snippets, and any page the agent
  then opens goes through `web_fetch` and its isolation. Diffs and CI logs are
  fenced but not scored, because code and build output routinely contain the
  phrases the scoring looks for.
- **Cost.** Ordinary content is unaffected and arrives verbatim, so documentation
  and code samples stay byte-exact. Only flagged content pays for the extra call.
  The score is deliberately loose, because a false positive costs one model call
  and some fidelity rather than a failed call.

Bidirectional text controls, which can make text render in a different order than
it reads, are stripped from all fenced content. This is defense in depth behind
the approval gate (you still approve network and MCP calls), not a replacement
for it: the classifier is a heuristic, and anyone who knows it is there can word
around it.

## GitHub tools

When the `gh` CLI is installed and authenticated, Houston offers dedicated tools
for the GitHub loop: pull requests (`gh_pr_create`, `gh_pr_list`, `gh_pr_view`,
`gh_pr_comment`, `gh_pr_review`, `gh_pr_checkout`, `gh_pr_checks`, `gh_pr_merge`,
`gh_pr_set_state`), issues (`gh_issue_list`, `gh_issue_view`, `gh_issue_create`,
`gh_issue_comment`, `gh_issue_set_state`), CI runs (`gh_run_list`, `gh_run_view`),
and repositories (`gh_repo_create`).
`gh_pr_review` submits an approve / request-changes / comment review,
`gh_pr_merge` lands an open PR (merge commit, squash, or rebase, optionally
deleting the branch), and `gh_pr_set_state` closes or reopens a PR, marks a draft
ready for review, or converts it back to a draft. `gh_issue_set_state` closes an
issue (as completed, not planned, or a duplicate of another issue) or reopens it.
They drive the user's local
`gh`, so no token is stored in the app. Each call is network-gated (always
prompts for approval) and the mutating ones are refused in plan mode. Because
these run `gh` outside the shell sandbox, they reach the network on approval,
unlike a raw `gh` in `run_shell`. If `gh` is not installed, these tools simply
are not offered and everything else still works.

## Remembering an instruction (#)

Start a line with `#` to turn it into a standing instruction: `# always run the
linter before committing`. Houston asks whether it applies to this project or to
you everywhere, appends it to the rules file it already reads on every run
(`AGENTS.md` in the project, or in `~/.claude`), and tells you which file it
wrote.

This is for the moment you notice "it should always do X", the moment you are
least likely to stop and open an editor. `#` alone is not a note, and a `#` in the
middle of a line is ordinary text.

## Project rules

Houston folds a small rules hierarchy into the system prompt each run: the global
`~/.claude/CLAUDE.md` first, then the project's own `AGENTS.md` / `CLAUDE.md` at
its root, then any `AGENTS.md` / `CLAUDE.md` in subdirectories (shallowest
first). Any rules file can pull in others with `@path` imports. These set coding
conventions, build/test commands, and house style; Houston treats them as
conventions, not as authority to change tool or permission behavior.

## Context, worktrees, and history

- **Compaction.** When a conversation grows too large, Houston first trims large
  tool output the agent has moved past (it can re-read anything it still needs),
  then summarizes the older part of the conversation, including the earlier steps
  of one long request, so it never overflows the context window. The request being
  worked on is always kept word for word. The threshold is sized
  automatically from the selected model's context window (a large-window model
  compacts later, a small local model sooner), and the summary is saved with the
  conversation so later turns extend it instead of re-summarizing from scratch.
  The full transcript stays on screen; only what is sent to the model is
  compacted. Set a fixed token threshold or disable it in Settings, *Context
  window*.
- **Worktrees.** In a git repo, a new chat defaults to running in a fresh,
  isolated worktree on its own branch under `.houston/worktrees/`, so the agent's
  edits never touch the current checkout. Untick *New worktree* to work in the
  repo directly. In a repo whose current branch has no commits yet (a fresh
  `git init`), the toggle starts off; a worktree can only branch from another
  branch that has commits, and is not offered when no branch has any.
- **Conversations** are saved per project folder. Chats can be exported as JSON
  or self-contained HTML and imported from either (an HTML export from an older
  version brings back only the chat text), searched, and forked.
- **The File menu** starts a new chat (⌘N), a new chat in another folder (⇧⌘N),
  or one in a recent folder (**Open Recent**), and imports or exports chats.
- **Undo a turn's file changes.** Before the agent edits a file, Houston
  snapshots it, so the latest turn's changes can be reverted with one click (and
  re-applied after a revert). This covers every file-editing tool, including
  multi-file patches (adds, updates, deletes, and moves) and edits made by a
  writable subagent the turn dispatched. Checkpoints persist on disk in your
  Houston profile, so the revert/redo affordance survives an app restart; the
  most recent 50 turns' checkpoints are kept. Shell-command side effects are not
  checkpointed: revert only restores files the editing tools touched.

## Help menu

The desktop app's **Help** menu (last in the menu bar on every platform) has
**Houston Guide**, which opens this guide, and **Report an Issue**, which opens a
new GitHub issue. On macOS the Help menu also has the system search field: type
part of a command's name (for example "settings") to find it in the menus. On
Windows and Linux the Help menu also holds **Share Houston…** and **Check for
Updates…**, which sit in the app menu on macOS.

## Sharing Houston

To invite a friend, click **Share Houston** at the bottom of the sidebar (the share
icon when the sidebar is collapsed), choose **Share Houston…** from the app menu on
macOS or the Help menu on Windows and Linux, or run "Share Houston" from the command
palette. On macOS it opens a menu with **Copy invite** and **Share via** (AirDrop,
Messages, Mail, and any app that adds itself to the system share menu). On Windows
and Linux the invite is copied right away, with options to copy it again or send it
by email. In the terminal, `/share` copies the invite (where the terminal allows
clipboard access) and prints it. The invite links to https://houstoncode.ai with no
tracking parameters.

## Settings and keys

Settings covers providers and keys, web search, approval mode and permission
rules, hooks, MCP servers, additional folders, context threshold, appearance
(theme, notifications), updates (installed version and a manual "Check for updates";
also **Check for Updates…** in the app menu on macOS or the Help menu on Windows and
Linux), and optional integrations (`gh`, formatters). API keys
are encrypted with the OS keychain and stay in the main process.

If a key won't save because the OS keychain is unavailable, Settings (and the Get started
checklist's Connect panel) says how to fix it
and offers **Restart Houston**. On macOS this usually means the Keychain prompt was
denied: macOS only asks again after a restart, so restart and choose **Always Allow**.
On Linux, unlock or install a keyring (such as GNOME Keyring or KWallet), then restart.

## Getting started in the desktop app

On a first launch the welcome screen shows a three-step **Get started** checklist:
connect a model (paste an API key for Anthropic, OpenAI, or Gemini, which is checked
with a live model listing before it is saved, or point at a local Ollama or LM Studio
server), open a project folder, and send a first task. Each step ticks itself off from
the app's real state, and the checklist goes away for good once the first task is sent.
When only that step is left, the cursor moves into the message box (which glows) and
the step suggests a first task: "Explain how this project is organized." for a folder
with files, or "Build a simple to-do list web page in this folder." for an empty one.
While the
checklist is open, each finished step shows what it set and has a **Change** button.
On "Connect a model" it reopens the panel with the saved key (**Replace key** to swap
it) and a model picker; on "Open a project folder" it reopens the folder picker. So you
can switch model, provider, or folder before your first task.

A few one-time tips then point at controls the first time they matter: the approval
mode, the **New worktree** toggle, and the message box (`@` files, `/` commands, `#`
rules) a couple of seconds before the first message (you can keep typing meanwhile), and **Revert** and **Changes** after the first turn
that edits files. **Skip tips** or Esc dismisses them. **Take the tour** also covers
steering (see "Typing while it works").
If you used Houston before this feature, nothing appears on its own. Anyone can play
the tips any time with **Take the tour** in the command palette (⌘K), or
**Help → Take the Tour…** in the menu bar.

## License and legal

Houston is open-source software under the **Apache License 2.0** (`LICENSE` in the
repository, and a copy inside the packaged app under `Resources/`). That means
anyone can use it for any purpose, read and modify the source, and redistribute
original or modified copies, commercially or not, as long as they keep the license
and copyright notices, pass along the `NOTICE` file, and state which files they
changed. The license also carries an express patent grant from every contributor.
It disclaims all warranties, and it does not license the Houston brand.

The brand is held back in two ways, because a name and a piece of artwork are
protected differently. The name is a trademark, and Apache-2.0 section 6 grants no
trademark rights. The logo is also copyrightable artwork, so the icon and logo files
are carved out of the Apache grant explicitly in `NOTICE`. Everything else in the
repository, source and non-source alike, is Apache-2.0 with no carve-out.
`TRADEMARK.md` sets out what anyone may do without asking: redistribute unmodified
builds under the name, package Houston for a package manager, refer to Houston in
their own work, and fork it and say so. What it asks in return is that a modified
build handed to other people carries a different name.

Contributions are covered by the same license under Apache-2.0 section 5, so there
is no CLA to sign; see `CONTRIBUTING.md`.

There is no Terms of Use, no account, and no acceptance gate: Houston opens
straight into the app on first launch. The license's warranty disclaimer (section
7) and limitation of liability (section 8) apply on their own, so there is nothing
for a user to click through.

Houston stores conversations, settings, and project data on the user's machine and
sends no telemetry anywhere. Prompts, code, and files go only to the model and
other providers the user configures, under those providers' own terms and
model-training policies. Third-party components bundled into the app are listed
with their license texts in `THIRD-PARTY-NOTICES.md`, which also ships inside the
packaged app.
