# Changelog

## v0.9.0 - 2026-10-21

Guided setup, side chat, turn receipts, inline visuals, new models, and many safety and reliability fixes.

This release also changes some defaults: reasoning now starts at High, and Enter steers a running turn.

### Breaking changes
- Reasoning effort now defaults to **High**. Installs that still had the old default of Off are moved to High once, so each step uses more output tokens and time. Lower it from the reasoning menu next to the model picker or with `/reasoning`. (#241)
- In the desktop app, pressing Enter while a turn runs now **steers** it (the agent reads your message before its next step). ⌘+Enter (Ctrl+Enter on Windows and Linux) queues the message for after the run instead. (#250)
- Slash commands typed mid-turn now run as commands instead of being sent to the model as text. `/compact` waits until the turn ends. In the terminal, a known command typed mid-turn runs once the turn ends. (#203)
- Shell commands that can discard work (for example `git reset --hard`, forced `git push`, `git clean -f`, `rm -r src`, `find … -delete`) now ask for approval in every mode, including full-auto. (#246)
- Shell allow rules now match quoting and whitespace exactly as bash reads them. A quoted `*` no longer matches a bare `*`. Rules saved by earlier versions mean exactly what their text says, so you may be asked once more for some commands. A saved shell allow ending in a lone backslash now matches nothing. (#206, #214)
- Headless runs (`-p`) now report how they ended through their exit code, so a run that stops at its step cap no longer exits 0 like a finished task. An invalid flag value exits 2 before any model call. (#220)

### Required steps
- If you want reasoning off, set it back to Off after updating (reasoning menu or `/reasoning`). (#241)
- If you script headless runs, check that your scripts handle the new exit codes. (#220)
- Optional: run **Clean up rules** in Settings to remove shell allow rules that no longer match anything. (#214)

### Added
- **Getting started checklist** for new users: connect a model, open a folder, send a first task. API keys are tested before they're saved, and finished steps can be changed. Existing users see no checklist or banner. **Take the tour** in the command palette and the Help menu replays the tips. (#159, #232, #234, #250, #251)
- **Side chat:** a docked panel for quick, read-only questions about the open chat, even while a turn runs. Send an exchange to the main chat or continue it in a new chat. Each chat keeps its side chat through plan reviews, chat switches, and restarts. Terminal: `/btw`. (#179, #224, #229)
- The agent can **propose parallel sessions** as a card (Start session, Do it here, Dismiss). Spawned sessions can start with a copy of the chat and report back when they finish. Sessions you start from a proposal don't count toward the background session limit. (#179, #208)
- Spawned sessions nest under the chat that started them in the sidebar, with foldable parents that stay folded across restarts. (#228, #230)
- **Turn receipts:** a "Recorded by Houston" row under each reply lists what actually ran: tests, builds, installs, browser checks, background servers, subagent work, the verify command, and files changed. It flags todo items marked done with nothing run behind them, and tracks progress on an accepted plan across turns. (#252, #261, #263, #264)
- Plan review shows whether the plan's checks can run on this machine (network, runtimes, dependencies) before you accept it. (#262)
- **Inline visuals** in replies: SVG and Mermaid diagrams render in the chat. Sandboxed interactive HTML is off by default (Settings > Appearance). (#269)
- The agent can show workspace images in a gallery, render HTML mockups at desktop, tablet, or mobile sizes, and capture the running app at several viewports and color schemes. The image viewer has a before/after compare slider plus Copy, Save, Show in Files, and Open file. (#267, #268)
- `view_localhost` supports double-click, key presses, and text checks in one multi-step call. (#227)
- **Searchable model picker** with per-model prices, a New mark, providers ready to use listed first, and badges read aloud by screen readers. (#163)
- Fetching a provider's models now summarizes what changed: new models, models no longer listed, and new models this build doesn't fully recognize. (#167)
- **Claude Haiku 5.5** with its 1M context window and prompt-length pricing, added to existing installs. (#175)
- **Gemini 4 Argon**, added to existing installs. Announced price changes now take effect on their date without an update. (#176)
- A **Help** menu on every platform, with Houston Guide and Report an Issue (and the menu search field on macOS). (#173)
- **File** menu items: New Chat, New Chat in Another Folder (⇧⌘N, rebindable), Open Recent, Import Chat, and Export Chat. (#218)
- Import chats from HTML exports. Older HTML exports bring back their text only. (#196)
- Background tasks moved to a **Tasks** tab in the right-hand dock, with readable command names, folders, port chips, and running work listed first. (#278)
- The Preview dock tracks every local URL a dev script prints and shows the full URL. The agent is told which address a server actually bound, and is warned when a port belongs to another project's server. (#245)
- The agent can close, reopen, and toggle draft on pull requests, and close or reopen issues, with an approval each time. (#219)
- Headless flags: `--effort`, `--max-turns`, `--max-cost`, `--verify`, and `--allow-shell-network`, a prompt from stdin, and a final `--json` result line. (#220, #233)
- Slash commands and ship buttons (Create PR, `/review`, `/agent`) now show as a compact chip instead of the long prompt Houston sent, with the full instructions behind a disclosure. (#174)
- The Steered label on a message is kept when the chat is reopened. (#253)

### Fixed
- Denying the macOS Keychain prompt no longer leaves key saves failing with no way out. Settings explains the fix and offers a **Restart Houston** button. (#158)
- `.env` values with secret-like names (`SECRET`, `TOKEN`, `PASSWORD`, …) are now redacted from output, and the agent can't write a redaction marker over a real secret. (#177)
- Closed several ways the agent could bypass approval prompts or permission rules: credential-file reads in parallel batches, subagent tool calls, `apply_patch` file rules, and respelled or quoted shell commands. Also fixed shell paths outside the project that went undetected, including Windows-style paths when Houston runs on macOS or Linux, and rule cleanup splitting chained commands into broader allows. (#182, #193, #206, #212, #213, #215, #226, #271)
- Closed symlink escapes: a repo's rules file or skill pointing outside the workspace is no longer read, and reverting a turn can no longer write outside the workspace. (#186, #194)
- The interactive Preview pane now blocks downloads and denies camera, microphone, location, and notification requests. (#185)
- Text from GitHub tool output (titles, branch names, error messages) is now marked as untrusted for the agent. (#222, #225)
- Reverting a turn no longer corrupts binary files, and the Revert bar now appears after every file-writing tool. (#197)
- Long single prompts are now compacted before they exceed the context window, and prompt caching stays effective across turns. (#181)
- A reply cut off at the output limit is continued automatically instead of ending the run, and a cut-off tool call is never run with empty arguments. (#189)
- A connection drop mid-reply now retries the turn instead of ending the run. (#239)
- A model the provider doesn't serve now gives a plain message, moves to your fallback model if one is set, and is flagged in the picker. (#242)
- Resending a message whose turn failed no longer sends it twice. (#243)
- Fixed conversations that became unusable after an empty reply, tool images with parallel calls, or a truncated OpenAI reply. (#183)
- Fixed Gemini tool-using turns that could fail on the second step. (#195)
- A turn now ends with an error instead of hanging or crashing when a hook receives a large payload. (#201)
- Background dev servers left running after a crash or force-quit are stopped on the next launch. (#236)
- Non-ASCII text in shell, search, and MCP output is no longer garbled. A crashed MCP server no longer crashes the terminal client. (#187)
- New files no longer show an extra blank added line in diffs. (#184)
- Generated chat titles no longer include markdown such as `##` or `**`. (#188)
- Usage after a fallback model is billed to the model that served it. The cost breakdown adds an "Earlier models" row so older conversations add up. (#198, #244)
- Fixed approval summaries for GitHub actions, files created by `apply_patch` (missing final newline, lost executable bit), and notebook cell inserts. (#190)
- Fixed custom agents whose `tools:` is written as a YAML list, and stale directory listings on Windows. (#198)
- The status bar now says when it's waiting for your answer, plan review, or approval. Stopped prompts read "Not answered" instead of internal text. (#192)
- The Preview pane no longer covers the Files, Scorecard, and Doctor panels, and Shift+Tab in Doctor no longer changes approval mode. (#191)
- The Changes, Files, Scorecard, and Doctor panels now trap and restore keyboard focus. (#204)
- Windows paths show their folder name instead of the full path. Shortcut hints follow your platform and key bindings. (#202)
- Every tool row now has a readable label. Connection retries update one notice instead of stacking six. (#205)
- Terminal: custom commands with hyphens, digits, or capitals now autocomplete, and prompts, menus, and long lists no longer print twice or overflow. (#199, #200)
- Updates that macOS refuses to install now offer a manual Download link instead of a Restart to install button that did nothing. (#209)
- npm no longer warns "Unknown env config devdir" on every command. (#238)
- Settings and chats opened by an older Houston version no longer cause migrations to run twice after upgrading again. (#164)
- Shell commands approved without network access now fail fast and say so. (#231)

### Changed
- "Reasoning off" on Claude models that always think now sends minimal reasoning and is labelled **Think: minimal**. (#162)
- The local providers are renamed **Ollama (local)** and **LM Studio (local)**, unless you renamed them yourself. (#161)
- Deleting a chat with an untouched worktree now asks a simple Delete/Cancel and removes the worktree. (#165)
- Revert and Redo no longer show a blocking dialog. A notice appears only if some files couldn't be restored. (#207)
- A long turn that keeps discovering new things can continue past the step cap instead of stopping mid-investigation. (#235)
- The agent now reads a file before overwriting or editing it, so it won't clobber changes you made mid-run. (#237)
- `/plan`, `/ask`, `/auto`, and `/full` confirm with the mode's name. Long dashes are removed from app and terminal text. (#191, #210, #256)

## v0.8.0 - 2026-10-17

Windows and Linux fixes, a host-aware system prompt, cheaper prompt caching, and defenses against injected text.

This release focuses on cross-platform parity, agent prompt quality, and hardening the agent against attacker-written content from GitHub, the web, and MCP servers.

### Breaking changes
- None.

### Added
- New system prompt guidance: the agent now verifies web apps by exercising real flows (log in, submit a form, call an endpoint) instead of just loading a page, reads values back from files or output rather than from what it meant to write, and never changes your local config (`.env`, credentials, tool or editor settings) to run a check. (#133)

### Fixed
- Windows: format-on-save and post-edit diagnostics now run, so formatters and checkers like ruff, gofmt, prettier, and eslint are found and executed correctly. (#147)
- Windows: `run_shell` commands after the first in a session no longer fail to start. (#146)
- Windows: a deny permission rule on a directory now correctly covers the files inside it. (#146)
- Windows: routine commands using `2>/dev/null` are no longer wrongly flagged as escaping the workspace and forced through approval. (#146)
- Windows: new git worktrees no longer show up as untracked. (#146)
- Windows: @-mentions now give correct directory suggestions and filename ranking in non-git folders. (#146)
- Linux: the agent is now told that `view_localhost` and the Preview panel usually cannot reach a dev server started by a separate `run_shell` command, and what to do instead, preventing wasted steps. (#143)
- Prompt caching: the system prompt now stays stable for the life of a conversation, so editing files no longer re-writes the whole history to cache on every turn (a significant cost reduction on coding sessions). (#134)
- Deleting a chat with "Delete & remove worktree" now shows a readable message when the worktree has uncommitted or untracked files, naming the branch and telling you the work was kept. (#127)
- Plan mode's refused-tools notice now names every tool it actually refuses, instead of an outdated short list. (#149)

### Changed
- The system prompt is now host-aware: it names the actual OS and states whether shell commands run confined, with Git Bash / cmd.exe notes on Windows and BSD-tools notes on macOS, and gives clearer guidance on tool choice, scope, and verification. (#128)
- GitHub CI tools (`gh_run_view`, `gh_run_list`, `gh_pr_checks`) now isolate attacker-controllable text (job, step, check, and workflow names, and logs) behind a safety fence, so a fork's workflow cannot pose as trusted instructions to the agent. (#150)
- GitHub issue and pull request text, `web_search` results, and MCP tool results are now fenced as untrusted content, closing a path for injected text to steer the agent. (#139)
- Tool results, agent notices, tool descriptions, and prompts now use plain punctuation and wording, which read more cleanly in transcripts. (#131, #129)

## v0.7.0 - 2026-10-14

Houston runs smoothly in new repos, picks dependencies that fit your toolchain, and runs longer on productive turns.

This release focuses on fresh `git init` projects, runtime detection, and smarter dependency choices by the agent.

### Breaking changes
- None.

### Added
- Houston now detects runtimes installed via nvm, fnm, Volta, mise, asdf, pyenv, rbenv, rustup, Go, Bun and Deno, and offers a one-click Install when a needed runtime is missing (#122)
- Productive turns can now run past the step cap automatically while they keep making progress, with a new Loop control setting (editing the step count pins the switch) (#116)
- The ship button now adapts to your repo state: Publish to GitHub, Push first commit, or Commit & push when there is no remote or no commits yet (#100)

### Fixed
- macOS sandboxed commands can now signal their own child and grandchild processes, fixing `kill EPERM` failures in tools like `next build`, webpack and jest (#115)
- Git context, diffs and the Changes panel now work in a fresh repo with no commits, including staged files (#113)
- Starting a chat with a worktree in a repo that has no commits no longer fails silently (#111)
- The model picker now reads "No models configured" for a provider with no models (#124)

### Changed
- Before scaffolding a project or adding a dependency, the agent now checks your installed toolchain and looks up current package versions instead of pinning versions from memory, and prefers packages without a native compile step (#125)

## v0.6.0 - 2026-10-07

Refreshed the Claude, GPT-6, and Gemini model defaults with corrected pricing, plus faster chat titles.

New installs seed the latest model lineups, and existing installs have the new models appended automatically with nothing removed, so your current default and any models you still use keep working.

### Breaking changes
- None.

### Added
- Claude 5.x defaults: new installs seed Fable 5.1, Opus 5.5, Sonnet 5.5, and Haiku 4.5, with Opus 5.5 as the default. Existing installs get the three new models added (#108)
- GPT-6 line: new installs seed gpt-6-astra, gpt-6.1-sol (default), and gpt-6-luna, with the models added to existing installs too (#103)
- Gemini defaults: new installs seed Gemini 3.1 Pro Preview, 3.8 Flash (default), and 3.5 Flash Lite, with the models added to existing installs (#99)

### Fixed
- Fresh installs no longer land on a broken Gemini default: the old 2.5 Pro seed could only fail for new accounts (#99)
- Claude 5.x models added via fetch from provider now show the reasoning toggle and R chip and send the correct thinking config, and keep working across long sessions (#98)
- Removed an em dash from the Changes panel scope line (#102)

### Changed
- Chat titles now generate in parallel with the first turn, so they appear sooner instead of after a long turn finishes. Chats whose first turn errors or is aborted now also get a generated title (#95)
- Corrected per-model pricing for OpenAI, Gemini, and Claude models to match published rates (#103, #99, #98)

## v0.5.0 - 2026-10-03

Share Houston from anywhere, smarter in-place updates, clearer connection errors, and live review findings.

This release also tightens shell permission matching and tidies saved rules.

### Breaking changes
- None.

### Required steps
- If you use shell permission rules, open Settings > Tools & Permissions and click "Clean up rules" to migrate saved rules: pure-scaffolding allows are dropped and keyword-prefixed allows (like `do wc`) unwrap to the real command. This closes a case where loop and subshell bodies could auto-approve or dodge a deny. (#85, #84)

### Added
- Share Houston: a one-click share action in the sidebar footer, a "Share Houston…" menu item, a command palette entry, and `/share` in the terminal UI. macOS opens the native share menu; Windows and Linux copy the invite and offer email; the TUI copies over OSC 52 (works over SSH) and always prints the link. (#93)
- Automatic update checks every 6 hours while Houston is open, not just at launch. (#83)
- The "Check for Updates…" dialog now has an Update button that downloads and restarts into the new version on signed macOS. (#83)
- A "Check for Updates…" item in a new Help menu on Windows and Linux. (#88)
- Review findings now appear live under the review row as each reviewer reports, with verification status, skeptic votes, and a severity tally, instead of only in the final report. (#24)

### Fixed
- Windows connection failures now trust the OS certificate store, so chats and title generation work behind TLS-inspecting proxies and endpoint security. (#87)
- Connection errors now include the real underlying cause (for example, an unresolved host or missing issuer certificate) instead of a bare "Connection error." (#87)
- "Clean up rules" now actually removes redundant and dead shell allow rules and shows a status line (removed N / already tidy / error). (#82)
- Count-only `head`/`tail` allow rules (like `tail -60`, `head -c 4000`) collapse to the bare program, so the Permissions panel no longer fills with near-duplicates. Rules naming a file or using `tail -f` stay exact. (#84)
- Replaced em dashes in retry, step-limit, output-limit, and verification notices in the chat transcript. (#89)

### Changed
- Update downloads on Windows and Linux now go to the website instead of the GitHub Releases asset list. (#88)
- The Updates controls moved out of Settings > Appearance into their own Updates tab. (#88)
- "What's new" now appears as a non-modal card in the bottom-right corner that does not steal focus, instead of a centered modal. (#83)
- Restarting to install an update, and quitting with ⌘Q, now ask first when chats or background tasks (terminals, backgrounded shells) are still running. (#83)

## v0.4.0 - 2026-10-01

Website redesign, plus more reliable shell handling and clearer update and download guidance.

This release reworks the marketing site and fixes several agent and shell behaviors.

### Breaking changes
- None.

### Added
- A small Beta badge now sits next to the Houston name across the website (#72)

### Changed
- Redesigned the marketing website on a small light/dark design system, with clearer page structure and copy (#60)
- Download cards now use generic device outlines instead of platform logos (#53)
- A step-capped turn now ends with a plain-text summary of what finished, what's left, and how to continue, instead of a dropped tool call (#68)
- In full-auto, shell commands that reference /dev/null, other content-free devices, or the temp directories no longer trigger an approval prompt (#64)
- Removed the "Not affiliated with NASA." footer line, and made the Beta badge tint read clearly as blue in light mode (#73, #72)

### Fixed
- The website now recommends the correct download for Apple Silicon Macs browsing in Safari (#71)
- Website assets revalidate on each use, so a corrected download recommendation shows as soon as a deploy lands instead of up to a day later (#74)
- A failed update check no longer shows the raw network error: offline now reads "Check your internet connection and try again." (#59)
- The terminal update notice headline is now trimmed at the first sentence rather than cut at 120 characters (#56)
- Tool calls whose arguments carry leaked tool-call markup are rejected instead of reaching you or failing with a misleading error (#67)
- kill_shell now reports what actually happened and cleans up orphaned background server processes that previously lingered and held ports (#66)
- Shell commands with file-descriptor redirections (for example `2>&1`) are no longer mis-split, preventing bogus "Always allow" permission rules (#65)
- Wrapped list items now render as proper lists on the privacy page (#61)

## v0.3.0 - 2026-09-27

This is Houston's first public release, published from github.com/houston-code/houston. Since 0.2.0, the terminal client has grown into a full interactive REPL (a raw-mode composer with vim keys, a real command menu, reviewable diffs, queued follow-ups, `/undo` and `/redo`, and a `/login` wizard). Both clients can now steer a running turn. The agent gains scheduled and resumable subagents, GitHub review and merge tools, and notebook editing. There are new Azure OpenAI, Microsoft Foundry, Bedrock, and Vertex providers, plus fallback-model chains, and MCP servers can now use OAuth sign-in and elicitation. Security work bounds what a full-auto run can send off the machine and closes several shell-approval and SSRF gaps.

### Breaking changes
_None._

### Required steps
_None._

### Added
- **Contributing:** the repository includes contributor guidelines.
- **Steer a running turn** from the desktop composer or the terminal instead of stopping it. If you decline a steer, it is queued as its own message.
- **Desktop slash commands:** `/doctor` health view, `/agent <name> <task>` to dispatch a workspace agent, `/clear`, `/skills`, `/agents`, and `#` to save a standing instruction to the instructions file Houston already reads.
- **Per-model cost breakdown** with the prompt-cache split, in the desktop control bar and in `/cost`. Cache usage is now reported for OpenAI-compatible, Gemini, and hosted providers, not just Anthropic, and host-listed per-model pricing is used when available.
- **Terminal REPL:**
  - A raw-mode composer with multi-line editing, bracketed paste, Ctrl-R history search, and vim keys.
  - A live command menu that includes project and user commands.
  - `/login` wizard for provider API keys (including a cloud provider's setup fields) and a `/settings` hub with `/hooks` and `/mcp` editing.
  - Reviewable diffs with line numbers, word-level marks, and highlighting.
  - Type while it works: follow-ups are queued, and Esc stops the run.
  - Shift-Tab cycles the approval mode, even mid-run.
  - `/undo`, `/redo`, and `/changes` over the existing file snapshots.
  - `/agent` to run one of your own subagents, and `/spawned` to open background sessions the agent started.
  - `/reasoning`, `/mcp tools`, `/verbose`, `/output`, `/compact`, `/review`, `/plan`, and custom commands.
  - `!` runs a command in your own shell, and `/image` pastes your latest screenshot.
  - The agent's todo list is drawn in full, and you get a bell, title, or notification when a run needs you.
  - Light and colorblind-safe themes that are remembered.
  - `--continue` and `--resume` at launch, plus a version indicator, a daily update check, and `/doctor`.
- **Bare `houston` command.** The standalone CLI installs to `~/.local/bin`. A new `houston providers` command adds and removes model hosts and stores their keys, and a missing key now gives a clear error that names the environment variable to set.
- **`--on-approval <allow|deny|fail>` for headless runs** decides what a gated tool call gets when there is no one to ask. It defaults to `deny`, so `--approval auto-edit` or the read-only default can't run shell commands or reach the network unattended; under `--full-auto` it defaults to `allow`. Use `fail` to exit non-zero when a run hits a permission wall.
- **Providers:** Azure OpenAI and Microsoft Foundry, native Amazon Bedrock and Google Vertex provider kinds, and fallback-model chains for when the selected model can't serve a turn. OpenAI Responses reasoning state is kept across tool calls. Gemini context windows come from the live model list, and explicit prompt caching is used on OpenAI-compatible routes that support it.
- **Subagents and automation:** scheduled runs, a model choice per dispatch, live progress, resumable and nested subagents, and a `spawn_session` tool for background sessions. Dispatched agents can get network access, but only with your consent.
- **GitHub tools:** `gh_pr_review` and `gh_pr_merge`.
- **MCP:** OAuth sign-in for remote servers, interactive elicitation (desktop, terminal, and headless), prompts, env and cwd settings, and clearer server status.
- **Notebooks:** `.ipynb` files are read as cells and edited cell by cell. Binary files are detected by their content.
- **Editing:** `apply_patch` accepts plain unified and `git diff` patches. The approval card shows line numbers and word-level diffs, and you can deny a request with a reason.
- **Permissions:** trusted folders (project config can be elevated only with your consent, and you can review those decisions in Settings or with `/trust`). There is also an admin-locked managed-policy tier that can only tighten rules, and a redesigned Permissions panel that generalizes and deduplicates `run_shell` rules.
- **Skills and commands:** skills can expose their bundled resource files. Custom commands can be user-scoped and support frontmatter and positional arguments, and `@`-completion now searches your files.
- **Checkpoints** are saved to disk and cover `apply_patch`. Context compaction uses a window-relative threshold and its state survives restarts.
- **Built-in guide skill** that lets Houston answer questions about its own features.
- **Updater:** shows download progress and offers restart-to-install.

### Changed
- The bundled runtime is Electron 44.4.5 (Chromium 152), which includes upstream security fixes (#23).
- Default Gemini models moved to the 3.x line. Retired models and `gemini-3.5-flash` (which couldn't serve reliably) were removed from the defaults.
- The "no progress" stall stop is gone, so long read-only investigations are no longer cut short. Stall and budget nudges now appear as system notes instead of user turns.
- Provider defaults are chosen by capability order, and a model removed from Settings is dropped from the selection automatically.

### Fixed
- Transient provider failures are retried, and the retry is reported. OpenAI, Responses, and Gemini now respect the requested max tokens. Gemini reports truncation and counts thinking tokens.
- Every write shows a true diff against the file on disk. An approval diff can no longer be empty, and the terminal no longer asks you to approve edits without showing them.
- `apply_patch` is all-or-nothing again: a failed patch is rolled back. Fuzzy edits re-adapt indentation, and several patch and edit data-loss gaps are closed.
- Cached reads are checked against disk before they are served. The JS search fallback now matches ripgrep, and real ripgrep errors are shown instead of a misleading message.
- Prompt-cache tokens are priced correctly, with one cost summary per turn.
- A steer that arrives during the final turn is no longer dropped or shown twice. Esc in `/doctor` no longer cancels a run.
- Terminal fixes: Ctrl-C interrupts a running turn, EOF no longer crashes a prompt, the `/login` key prompt no longer echoes the key, text is measured by Unicode width, and hook and MCP edits apply on the next message instead of after a restart.
- `/model` and `/resume` keep the saved model and conversation metadata in sync, including in headless resume.
- Windows `gh.exe` detection, and several MCP, markdown-rendering, and atomic-write (cross-process) reliability fixes.
- The website's Linux download buttons, the README install table, and the GPG example now use the real artifact names (#20).

### Security
- **Bounded exfiltration in full-auto:** per-destination network consent, masking of credentials in outbound requests, a sandbox egress allowlist once shell network access is granted, and a prompt before reading credential or secret files.
- **Untrusted web content:** `web_fetch` output is fenced, screened for prompt injection, and read in isolation. DNS-name SSRF and DNS rebinding are blocked by pinning vetted IPs.
- **Shell approvals:** five fail-open gaps are closed. Permission-rule subjects are canonicalized so quoting and path tricks can't slip past a rule. Hook-rewritten arguments are re-checked, and a hook "approve" can't bypass a managed or project ask rule. A writable subagent's unconfined shell fails closed and prompts you.
- **Secrets:** subagent outputs are redacted before they reach the provider, and AWS temporary key IDs and Google OAuth tokens are now detected. Houston warns when key storage falls back to weak encryption.
- **Files:** credential files (the CLI credentials, MCP OAuth tokens, shell snapshots) are written owner-only (0600).
- **Other:** git-derived writable roots are validated. MCP refuses a cross-origin SSE endpoint before sending credentials. Exported conversations carry a Content-Security-Policy.
- Releases are gated on a scan of the bundled native runtime, and ship with SBOMs, cosign signatures, and SHA-256 checksums (see the README for how to verify a download).

## v0.2.0 - 2026-07-12

> PR numbers in this section refer to the pre-release development repository and do not link to this one.

Houston 0.2.0 takes the app fully cross-platform, adding Windows and Linux execution backends alongside signed, notarized macOS builds with in-app auto-update. Beyond the desktop app, it adds a standalone CLI and an interactive terminal mode, broader model and provider support (the OpenAI Responses API, Amazon Bedrock, MCP resources, and one-click setup for known model hosts), and richer agent workflows including writable subagents, invocable skills, session persistence and search, and durable long-context memory. It also lands a large batch of security hardening (secret redaction, SSRF and symlink-escape fixes, and honest sandbox confinement) plus dozens of UX refinements across chats, diffs, the Files panel, and PR tooling.

### Breaking changes
_None._

### Required steps
_None._

### Added
- Sign + notarize macOS builds and enable in-app auto-update (#<!-- -->420)
- Offer git init on the first agent write into a non-repo (#<!-- -->418)
- SEO + AI-discoverability (FAQ, rich schema, llms.txt) (#<!-- -->414)
- Offer "Initialize git repository" in the empty Changes panel (#<!-- -->413)
- Real screenshot, consistent logo, docs-sync test (#<!-- -->411)
- Marketing + download site with Cloudflare Pages deploy (#<!-- -->409)
- Titlebar tooltips, Files "Open", scorecard in Settings; scope background tasks; fix drawer close (#<!-- -->408)
- RepoIdentity resolver for stable per-repo scope keys (#<!-- -->401)
- Move Legal into its own tab (#<!-- -->400)
- Redact secrets from composer input and titles (#<!-- -->396)
- Enable interleaved thinking on legacy Claude 4 models (#<!-- -->383)
- Support MCP resources (list + read) (#<!-- -->382)
- Make project skills invocable via a `skill` tool (#<!-- -->381)
- Opt-in, sandbox-confined writable subagent tier (#<!-- -->380)
- Expand hook lifecycle + JSON directive protocol (#<!-- -->379)
- Redact secrets from tool results and logs (#<!-- -->378)
- Add claude-fable-5 and lowercase seeded model labels (#<!-- -->368)
- Standalone CLI: run -p/-i without Electron (#<!-- -->360)
- Schema-version persisted chats; migrate on load, quarantine corrupt files (#<!-- -->352)
- Multi-line composer (raw-mode stage 2) (#<!-- -->350)
- Arrow-key pickers for approvals & ask_user (raw-mode stage 1) (#<!-- -->349)
- Plan-mode review handoff (#<!-- -->348)
- Image input (/image <path>) (#<!-- -->347)
- Color themes (/theme default | bright | mono) (#<!-- -->346)
- Capability introspection (/skills /agents /mcp /hooks) (#<!-- -->345)
- --continue / --resume bridge between -p and -i (#<!-- -->344)
- Session search (/resume <query>) and /fork (#<!-- -->343)
- Tab completion (slash + @-file) and persistent history (#<!-- -->342)
- Thinking/elapsed spinner (flicker-safe single-line redraw) (#<!-- -->340)
- Syntax-highlight fenced code blocks (#<!-- -->338)
- Render assistant markdown to ANSI in the terminal (#<!-- -->337)
- Status line, live progress events & ANSI-aware wrapping (#<!-- -->336)
- Stall detection, adaptive turn budget with landing reminder, and end-of-run verification gate (#<!-- -->328)
- Durable context: recall tool, pinned working memory, and tool-result eviction (#<!-- -->326)
- Persist sessions and resume with /resume (#<!-- -->325)
- Parallelize the read subset of mixed turns and validate tool-call arguments before dispatch (#<!-- -->324)
- Per-model loop scorecard aggregated locally from persisted runs (#<!-- -->323)
- Content-addressed cache for repeated read-only tool calls within a run (#<!-- -->322)
- Diff previews, result snippets & session cost meter (#<!-- -->321)
- Interactive terminal mode (Houston -i), foundation (#<!-- -->320)
- Persistent "Always allow/deny" + per-kind, conversation-scoped "Allow for run" (#<!-- -->315)
- Syntax-highlight the file preview code pane (#<!-- -->313)
- Finder-like Files panel with in-app preview (#<!-- -->312)
- Live preview dock for started dev servers (#<!-- -->311)
- Create PR bar at the top of the composer (#<!-- -->305)
- Meter dispatch_agent subagent token cost into session usage (#<!-- -->303)
- Roll review token cost into the session usage meter (#<!-- -->302)
- Add "+" attachment menu (#<!-- -->298)
- Make the Pinned and Ungrouped sections collapsible (#<!-- -->293)
- Show a "running" indicator on every chat with a live run (#<!-- -->284)
- Add Amazon Bedrock (API key) to the host catalog (#<!-- -->279)
- Send reasoning_effort for host-listed reasoning models (#<!-- -->277)
- Stream review_changes subagents as their own live rows (#<!-- -->271)
- Live-preview the appearance theme before saving (#<!-- -->266)
- Surface review progress and token cost (#<!-- -->265)
- Split large diffs by file instead of truncating (#<!-- -->264)
- Per-finding multi-vote verification (high effort) (#<!-- -->263)
- Path scoping, finding dedup, and a re-review nudge (#<!-- -->262)
- Capability metadata from host model listings (#<!-- -->261)
- Per-provider custom HTTP headers (#<!-- -->260)
- One-click catalog of known model hosts (#<!-- -->259)
- Persist a failed turn so the Retry banner survives reload (#<!-- -->258)
- Explain the no-tools warning with a hover tooltip (#<!-- -->256)
- Warn at selection time when a local model can't call tools (#<!-- -->253)
- Friendlier error when a model can't do tool calling (#<!-- -->252)
- Show repo name with branch for worktree chats (#<!-- -->234)
- Block page subresources to private/LAN/metadata hosts (#<!-- -->230)
- Show tool-produced images to OpenAI and Gemini (#<!-- -->229)
- Drag-to-reorder chats within a group / ungrouped (#<!-- -->228)
- Beautify and clarify the settings console (#<!-- -->227)
- Make dragging chats into groups actually work (#<!-- -->226)
- Add Icon component and convert font-fragile glyphs to inline SVG (#<!-- -->225)
- Archive/unarchive chats and filter by status (#<!-- -->223)
- Native Settings… and Check for Updates… app-menu items (all platforms) (#<!-- -->221)
- Show optional-integrations status (gh, formatters) + how to enable (#<!-- -->220)
- AI-generated release notes with deterministic fallback (#<!-- -->206)
- Manual release pipeline + public distribution repo (#<!-- -->203)
- Opt-in diagnostics-on-save feedback loop (#<!-- -->200)
- Cross-platform build + distribution (4/4) (#<!-- -->195)
- Windows execution backend + portability (3/4) (#<!-- -->194)
- Linux bubblewrap backend (2/4) (#<!-- -->193)
- Cross-platform backend abstraction + honest sandboxed flag (1/4) (#<!-- -->192)
- Keyboard shortcuts: command palette, history recall, session switching, find, mode cycling, customization (#<!-- -->189)
- Move the approval-policy field after the thinking field (#<!-- -->185)
- Future-proof ordering + window heuristics for new releases (#<!-- -->183)
- Show the current branch when "New worktree" is off (#<!-- -->174)
- Order picker by capability, families grouped, newest first (#<!-- -->173)
- Custom model picker: sorted, consistently labeled, opens upward (#<!-- -->171)
- Fill the desktop on first launch, restore saved bounds after (#<!-- -->170)
- Inline worktree setup in the control bar; default new chats to a worktree (#<!-- -->165)
- In-app multi-tab integrated terminal (#<!-- -->164)
- Report real per-model context window (1M for current Claude) (#<!-- -->161)
- Redirect package-manager caches so installs succeed (#<!-- -->153)
- Issue, CI-run, and PR-checks gh tools (#<!-- -->152)
- Created/merged PR notices in the session transcript + desktop ping (#<!-- -->151)
- Resizable + collapsible left pane (#<!-- -->150)
- Gh_repo_create tool + clearer sandbox-network messaging (#<!-- -->149)
- Model-summarized chat titles (#<!-- -->148)
- In-app update banner, manual check, and post-restart "What's new" (#<!-- -->147)
- Native desktop notifications for agent events (#<!-- -->145)
- Queue input typed mid-run, sent combined when the run ends (#<!-- -->144)
- Create PR button in the Changes panel (agent hand-off) (#<!-- -->143)
- Ask_user tool for structured questions (#<!-- -->142)
- Working-tree Changes panel (uncommitted diff vs HEAD + untracked) (#<!-- -->141)
- Lazy MCP tool loading via find_tools (#<!-- -->140)
- First-class PR-sweep board (pr_sweep) (#<!-- -->139)
- First-class GitHub PR tools via the gh CLI (#<!-- -->138)
- Fold read bursts into "Read N files" + drop list_dir rows (#<!-- -->137)
- Seed GPT-5 family + backfill built-in defaults on upgrade (#<!-- -->135)
- Make the shell-output context budget user-configurable (#<!-- -->134)
- Apply reasoning-effort changes to the in-flight run (#<!-- -->133)
- Start a new chat in its own branch + git worktree (#<!-- -->131)
- Apply approval-policy changes to the in-flight run (#<!-- -->130)
- Hardened read-only git_status / git_diff tools (#<!-- -->125)
- Per-model system-prompt addendum (#<!-- -->123)
- Git worktree awareness in agent context (#<!-- -->122)
- OAuth-credential store foundation (api-key + oauth shapes) (#<!-- -->121)
- SSE transport + static bearer/header auth (#<!-- -->120)
- Local plugin system with lifecycle hooks (#<!-- -->119)
- Opt-in auto-format after edits (#<!-- -->118)
- Export a conversation as self-contained HTML (#<!-- -->117)
- Per-agent tool restriction for custom subagents (#<!-- -->116)
- Vision/reasoning capability flags + composer gating (#<!-- -->115)
- /compact, /plan|/ask|/auto|/full, /help (#<!-- -->114)
- Add approval-gated view_localhost screenshot tool (#<!-- -->113)
- Xhigh effort + reasoning-summary mode + verbosity (#<!-- -->112)
- OpenAI Responses API adapter (GPT-5 / o-series) (#<!-- -->111)

### Fixed
- Repair model-picker spec (stale trigger selector + labels) (#<!-- -->423)
- Pass --publish explicitly on every release-publish build leg (#<!-- -->422)
- Pass --publish never in release-prepare so it needs no GH_TOKEN (#<!-- -->421)
- Correct the Apple logo in the macOS download cards (#<!-- -->419)
- Root icons, Safari header blur, release-fetch timeout (#<!-- -->417)
- Keep scrollbars slim and auto-hiding under macOS "Always" (#<!-- -->416)
- Ignore ast-grep postinstall warning and de-flake real-git tests (#<!-- -->410)
- Terminate run_shell gracefully and let slow installs finish (#<!-- -->407)
- Let model and header lists be edited by hand (#<!-- -->406)
- Set color-scheme so native scrollbars match the theme (#<!-- -->394)
- Import ./syntax statically to drop dead dynamic-import chunk (#<!-- -->386)
- Surface headless run signals: session id, limits, tool failures, cost (#<!-- -->377)
- Correct interrupt, picker, and width handling in the terminal adapter (#<!-- -->376)
- Visual polish: code highlighting, find bar, focus rings, task badge (#<!-- -->375)
- Keyboard-operable tool/chat rows, live status region, aria-pressed (#<!-- -->374)
- Inert empty permission pattern; show forced approval prompts (#<!-- -->373)
- Settings modal: safe rule default, transactional keys, inline errors (#<!-- -->372)
- Model picker, reasoning control, command-palette polish (#<!-- -->370)
- Clearer errors and profile-path robustness (#<!-- -->366)
- Composer input: IME, autosize, attachment feedback, menus (#<!-- -->365)
- Drop view_localhost from the toolset when no capture backend (#<!-- -->364)
- Escape routing, focus retention, send races, queue dispatch (#<!-- -->363)
- Keep provider/MCP header secrets encrypted, off disk and the renderer (#<!-- -->361)
- Close shell allow-rule bypass via substitution parens (#<!-- -->358)
- Close dangling-symlink workspace write escape (#<!-- -->356)
- Honor a picked subdirectory instead of silently re-rooting to the repo root (#<!-- -->353)
- Stop keystroke-echo corruption during streaming, harden input (#<!-- -->334)
- Correct intra-turn read-after-write ordering and abort result-loss in partial parallelism (#<!-- -->333)
- Include apply_patch edits in pinned files-in-play, and cover documents-eviction (#<!-- -->330)
- Rule glob `*` spans `/` for URLs and nested paths (#<!-- -->314)
- Redirect Gradle/Deno/Bun caches to the writable temp dir (#<!-- -->309)
- Redirect the node-gyp devdir to the writable temp dir (#<!-- -->308)
- Redirect the Cargo home to the writable temp dir (#<!-- -->307)
- Redirect Go build + module caches to the writable temp dir (#<!-- -->306)
- Make git worktree dirs writable so git works under the sandbox (#<!-- -->304)
- Tidy the Changes panel (drop status badge, trim button label) (#<!-- -->300)
- Reserve permanent space for the running dot (#<!-- -->291)
- Launch the chosen editor by app name on macOS (#<!-- -->289)
- Restore the revert/redo affordance when a conversation is re-opened (#<!-- -->288)
- Replay pending approvals/questions when re-adopting a run (#<!-- -->286)
- Recover conversations from interrupted tool calls (#<!-- -->285)
- Stop new chats from opening in a deleted worktree's phantom repo (#<!-- -->281)
- E2e boot test polluted the real profile with legal-gate acceptance (#<!-- -->276)
- Render keyboard-shortcut chips in the UI font (#<!-- -->267)
- Strip ChatML/Hermes control tags leaked into text (#<!-- -->254)
- Recover tool calls emitted as text by local models (#<!-- -->251)
- Use adaptive thinking for Claude 4.6+ models (#<!-- -->249)
- Let ⌘-shortcuts work while the terminal is focused (#<!-- -->246)
- Cap imported conversation file size and content (DoS) (#<!-- -->245)
- Bound the markdown parser to stop O(n^2)/ReDoS renderer freeze (#<!-- -->244)
- Permission allow-rule must cover every chained sub-command (#<!-- -->243)
- Confine workspace rules @imports to the workspace (prompt exfiltration) (#<!-- -->242)
- Block IPv4-mapped IPv6 SSRF bypass in web_fetch/view_localhost (#<!-- -->241)
- Realpath-confine file tools against symlink workspace escape (#<!-- -->240)
- Pin the main window against off-origin navigation (will-navigate + CSP) (#<!-- -->239)
- Harden auto-run git against .git/config code execution (#<!-- -->237)
- Don't auto-execute workspace plugins (.houston/plugins), which allowed code execution on repo open (#<!-- -->236)
- Auto-answer ask_user so a headless run can't hang (#<!-- -->235)
- Dim the dragged chat, drop the whole-section highlight (#<!-- -->233)
- Remove footer New Group button; name group when adding chat to a new one (#<!-- -->222)
- Stop pinning mac target arch so CLI flag selects it (#<!-- -->217)
- Resolve POSIX shell instead of hardcoding /bin/bash (#<!-- -->212)
- Harden Windows process-tree kill fallback (#<!-- -->208)
- Make sandbox-confinement signal honest and gate shell approval on it (#<!-- -->191)
- Base the worktree picker on the repo mainline, not a prior chat's worktree (#<!-- -->190)
- ⌘W closes the window when no terminal is open (#<!-- -->188)
- Make the Create-PR hand-off stack-aware (#<!-- -->187)
- Make the confirmation prompt's Cancel truly cancel (#<!-- -->186)
- ⌘W closes active tab when focused; persist sessions across hide/show (#<!-- -->184)
- Polish the inline worktree controls (#<!-- -->169)
- Correct stale Claude per-token pricing (#<!-- -->166)
- Keep project folder name visible when the bar is crowded (#<!-- -->160)
- Prevent concurrent runs on one conversation (log corruption) (#<!-- -->146)
- Render compaction summary as markdown (#<!-- -->136)
- Cap a single shell tool result so it can't swamp the context (#<!-- -->132)
- Compact by token budget; show context size for all providers (#<!-- -->129)
- Kill the whole process tree on run_shell timeout/abort (#<!-- -->127)
- Recover from context-window overflow instead of failing the run (#<!-- -->126)
- Preserve both ends of foreground run_shell output (#<!-- -->109)

### Changed
- Move reveal-in-file-manager gesture out of the agent engine (#<!-- -->355)
- Make view_localhost engine code Electron-free via injected capture backend (#<!-- -->341)
- Inject settings/secrets into the agent engine via agentHost (#<!-- -->339)
- Drop the speculative gpt-6 generation catch-all (#<!-- -->319)
- Drop redundant dims alias (#<!-- -->299)
- Code-split modal overlays out of the initial bundle (#<!-- -->159)
- Load provider SDKs lazily instead of at startup (#<!-- -->158)
- Minify bundles and strip dead weight from the asar (#<!-- -->157)
