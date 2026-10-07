# Changelog

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
