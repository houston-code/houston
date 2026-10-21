# Inline visuals in the transcript (design)

Status: built (phases 1 to 3), with two changes from the plan below. Mermaid renders
in a hidden window in the main process (on its own locked-down session, loading only
the vendored `mermaid.min.js`) instead of a hidden frame in the renderer, and the
result is still shown through an `<img>`. Mermaid is a devDependency whose single
prebuilt file is copied into the build; `scripts/vendored-js.mjs` keeps its whole
dependency tree in the notices and the license gate.

Verified in the real app with a hostile HTML visual: no access to the app or the top
page, no storage, no WebRTC (constructors removed; the window's WebRTC policy also
keeps it off UDP), no fetch, image, beacon, WebSocket, form, popup, top navigation,
or self navigation to the web, and local TCP and UDP listeners received nothing. The
frame has an opaque origin and runs in its own process: the chat stayed responsive
(0.09 s) while a visual spun for 8 s. DNS prefetch is off app-wide (see
ui-mockup-rendering-design.md).

## Problem

The agent can only answer in text. The transcript renderer
([`markdown.ts`](../src/shared/markdown.ts) parsed, drawn by
[`Markdown.tsx`](../src/renderer/src/components/Markdown.tsx)) supports headings,
emphasis, links, lists, tables, blockquotes and highlighted code blocks. Ask for an
architecture diagram, a state machine, or a quick chart of benchmark numbers and the
user gets source code they have to paste somewhere else to see.

Houston already renders visuals in three places, which this design reuses:

- **File preview** ([`FilePreview.tsx`](../src/renderer/src/components/FilePreview.tsx))
  shows `.svg` files through `<img src="data:image/svg+xml,...">`, with a
  Rendered/Code toggle. An SVG loaded as an image cannot run script or fetch
  anything, so it is inert by construction.
- **Tool cards** already show a thumbnail of an image the agent reads with
  `read_file` (`tool-row__image` in the tool group). The ROADMAP entry asking for
  this is stale.
- **Native preview panes** ([`preview.ts`](../src/main/preview.ts),
  [`localhostCapture.ts`](../src/main/localhostCapture.ts)) host untrusted pages in
  separate sandboxed `WebContentsView`s with navigation pinned and permissions denied.

## Goals

1. The agent can show a diagram, chart or small interactive view inline, in the
   turn where it is relevant, with no extra round trip.
2. Nothing the model writes can reach `window.api`, the filesystem, the network, or
   the rest of the UI. Model output is treated as hostile, because prompt injection
   through fetched pages, issues or CI logs can steer what the model writes.
3. Conversations stay plain text on disk and degrade gracefully everywhere a visual
   cannot be drawn (the CLI, an older build, a copied message).

Non-goals for now: math typesetting, remote images in markdown, an editable canvas,
saving a visual as a file (the agent can already `write_file` an `.svg` or `.html`).

## Mechanism: fenced blocks, not a tool

Two ways for the model to produce a visual:

| | Fenced code block (` ```mermaid `) | Dedicated tool (`show_visual`) |
|---|---|---|
| Round trips | none, streams with the reply | one tool call per visual |
| Placement | exactly where it sits in the prose | between text segments, as a tool card |
| Persistence | already persisted (it is message text) | new tool-result shape to persist and replay |
| CLI fallback | already prints as a code block | needs its own text rendering |
| Model familiarity | high, models emit these unprompted | needs prompt + schema teaching |
| Error feedback to model | none (renders client-side) | can return "parse error at line 4" |

**Decision: fenced blocks.** Zero cost per visual, correct placement and free
persistence outweigh error feedback. A diagram that fails to render shows the error
and the source, which is no worse than today. If error feedback turns out to matter, a
later read-only `check_visual` tool can validate source without changing the format.

### Which fences render

Rendering every ` ```html ` or ` ```svg ` block would break the common case where the
user asked for code. Rules:

| Fence | Default view | Notes |
|---|---|---|
| ` ```mermaid ` | Rendered | Nobody wants Mermaid source by default. Code tab available. |
| ` ```svg ` | Rendered | Code tab available, same toggle as FilePreview. |
| ` ```html visual ` | Rendered (live, sandboxed) | Opt-in info string the model uses only when it means "show this". |
| ` ```html ` (plain) | Code | Adds a "Preview" button that renders it in the same sandbox on click. |

Every rendered block keeps the existing code bar (language label, Copy) plus a
Rendered/Code toggle, so source is always one click away.

## Rendering pipeline

```
assistant text ──parseMarkdown──▶ code block {lang, info, closed}
                                       │
           ┌───────────────────────────┼───────────────────────────┐
         svg                       mermaid                   html visual
           │                           │                           │
   <img> data URL           render frame (sandboxed)      live frame (sandboxed)
   (inert, in renderer)     mermaid → SVG string          model HTML runs here
                                       │                    reports height only
                               <img> data URL
```

### 1. Parser changes

`parseMarkdown` currently keeps only the first word of the info string and does not
record whether a fence was closed. Add `info: string` (the full info string) and
`closed: boolean` to the `code` block. Render only `closed` blocks: while a fence is
still streaming it shows as code with a "Rendering when complete" label, so
half-written SVG or Mermaid never flickers through error states. The TUI renderer
([`markdown-ansi.ts`](../src/main/markdown-ansi.ts)) ignores the new fields.

`Markdown` gains a `visuals?: boolean` prop. It is on for assistant messages,
`PlanPanel`, and markdown files in `FilePreview` (a repo README with a Mermaid
diagram renders too). It stays off for `QuestionCard` and `ElicitationCard`, whose
text can come from MCP servers.

### 2. SVG: inert image in the renderer

Reuse FilePreview's `svgDataUrl`. The main window CSP already allows
`img-src 'self' data:`. An SVG drawn as an `<img>` runs no script, loads no external
resources, and cannot navigate, so no further sandbox is needed. Cap the source at
512 KB; over the cap, show code only.

Theming: an image cannot read the app's CSS variables. Draw it on a neutral card
(light surface in both themes, like an embedded figure) so model-chosen colors stay
readable, and tell the model in the prompt to use explicit colors.

### 3. Mermaid: render in a sandbox, display as an image

Mermaid parses model-written text and builds DOM, and has had XSS advisories. It does
not run in the renderer origin. Instead:

1. A hidden, shared **render frame** (one per window) loads a bundled page from a
   custom `houston-visual://` scheme: `<iframe sandbox="allow-scripts">`, no
   `allow-same-origin`, so it has an opaque origin and no access to the parent.
2. The renderer `postMessage`s `{ id, kind: 'mermaid', source, theme }` to it.
3. The frame runs Mermaid with `securityLevel: 'strict'` and posts back
   `{ id, svg }` or `{ id, error }`.
4. The renderer displays the SVG through the same `<img>` data-URL path as step 2.

So Mermaid's output is inert even if Mermaid itself is tricked into emitting script.
Mermaid's own theme switch handles light and dark: re-render on theme change, and
cache results in memory by `hash(source + theme)`. Timeout of 5 s per diagram and a
50 KB source cap; a timeout reloads the render frame.

Mermaid is MIT licensed, but its dependency tree (d3, dagre, cytoscape, DOMPurify,
KaTeX and others) is several megabytes and adds rows to
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) and the SBOM. It is bundled
into the render frame's own entry (a separate electron-vite input), never the main
renderer bundle, and loaded once on the first diagram. Measure the installer-size
delta before merging.

### 4. Interactive HTML: live sandboxed frame

For ` ```html visual ` (and a clicked "Preview"), the model's document runs for real,
in an iframe the user sees:

- **Delivery.** The renderer sends the HTML to main over IPC
  (`visual:register(html) → id`, 256 KB cap). Main keeps it in an LRU map (cap 64
  entries) and serves it at `houston-visual://doc/<id>`. Content never goes in the
  URL. The protocol handler serves only that map and the fixed bundled assets, never
  a filesystem path.
- **Frame.** `<iframe sandbox="allow-scripts" src="houston-visual://doc/<id>">`. No
  `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-modals`,
  `allow-top-navigation*`, `allow-downloads` or `allow-pointer-lock`, and no `allow=`
  permissions-policy attribute (so camera, microphone, geolocation, clipboard and
  fullscreen are all denied).
- **Response headers** set by the protocol handler:
  `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'
  houston-visual:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
  connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none';
  base-uri 'none'`, and `X-DNS-Prefetch-Control: off`.
  Model visuals are self-contained by contract: no CDN scripts, no fetches.
- **Sizing.** Main injects a small runtime script ahead of the model's markup that
  reports the root element's box height to the parent with a
  `ResizeObserver`. The parent accepts only `{ type: 'resize', height }` messages,
  only when `event.source === iframe.contentWindow`, and clamps height to 80 to
  800 px (internal scroll beyond that). The frame sits in normal document flow, so it
  cannot overlay the composer or approval prompts.
- **Budget.** Frames render when scrolled into view (IntersectionObserver). At most
  3 are live at once; the others show a static "Click to run" placeholder.
  Re-opening a conversation does not auto-run old HTML visuals until they scroll
  into view.
- **Parent CSP.** The main window CSP gains `frame-src houston-visual:`. The scheme is
  registered with `protocol.registerSchemesAsPrivileged` (`standard`, `secure`) so
  Chromium applies the response CSP. The preload does not run in subframes
  (`nodeIntegrationInSubFrames` stays unset), so `window.api` does not exist inside
  the frame.

### Threat model for HTML visuals

Adversary: hostile HTML/JS that a prompt-injected model wrote, possibly embedding
secrets from the conversation. It must not be able to:

| Goal | Blocked by |
|---|---|
| Call `window.api` / touch the app DOM | opaque origin, no preload in subframes |
| Exfiltrate over HTTP, images, fonts, CSS | CSP `connect-src`/`img-src`/`font-src`, no remote sources |
| Navigate the app or open windows | sandbox (no top-navigation, no popups); existing `will-navigate` guard |
| Submit a form somewhere | no `allow-forms`, `form-action 'none'` |
| Spawn workers or nested frames to escape CSP | `worker-src 'none'`, `frame-src 'none'` |
| Grab camera, mic, location, clipboard | no `allow=` attribute; plus a permission handler (below) |
| Freeze the UI with a busy loop | out-of-process frame (must verify, below), lazy + capped live frames |
| Spoof Houston UI (fake approval, fake key prompt) | visible frame border and "Visual" label, in-flow layout, no forms |

**Must-verify before HTML visuals ship** (each becomes a test with a hostile
fixture):

1. **WebRTC.** CSP `connect-src` does not govern `RTCPeerConnection`; ICE/STUN
   traffic can carry data out. Verify against a local STUN listener. If it leaks,
   remove the WebRTC constructors in the injected runtime (which runs first, and
   `frame-src`/`worker-src 'none'` deny a fresh realm to recover them) and add a
   test that fails if the listener receives anything.
2. **DNS prefetch.** The header alone does not stop an explicit
   `<link rel="dns-prefetch">` (checked for `render_mockup`, see
   ui-mockup-rendering-design.md). The app-wide
   `--blink-settings=dnsPrefetchingEnabled=false` switch that change added covers
   these frames too; confirm it with a network log.
3. **Process isolation.** Confirm Chromium in Electron 44 puts opaque-origin
   sandboxed iframes in their own process (`IsolateSandboxedIframes`) by checking
   that `while(true){}` in a frame leaves the transcript responsive. If not, host
   live HTML visuals in a `WebContentsView` overlay like `preview.ts` (own process,
   own session partition) and accept the layout cost.
4. **Permissions.** The main window's default session has no permission handler,
   so Electron grants requests by default. Add a
   `setPermissionRequestHandler`/`setPermissionCheckHandler` that denies anything
   whose requesting origin is `houston-visual:` or opaque.

Until all four pass, phase 3 stays off (behind a setting that defaults off), and
` ```html visual ` falls back to the plain-HTML "Preview on click" behavior.

## Teaching the model

Add a short "Visuals" paragraph to the **desktop** system prompt only (the CLI
prompt and toolset are separate goldens), listing only the formats that have shipped:

> When a diagram or chart would explain something better than prose, include it in
> your reply: a ` ```mermaid ` block for flowcharts, sequence, state and ER diagrams;
> a ` ```svg ` block for anything custom (self-contained, explicit colors, readable
> on a light background); and a ` ```html visual ` block only for something genuinely
> interactive. Visuals cannot load anything from the network. Use them when they
> help, not by default.

Regenerate `system-prompt.desktop.txt` with `npm run goldens:update`; never
hand-merge it.

## CLI and other fallbacks

- The TUI already prints these blocks as highlighted code. Add a one-line dim hint
  under rendered-kind fences ("diagram, shown rendered in the Houston app").
- Copying a message copies the source, so pasting elsewhere still works.
- An older Houston build reading a newer conversation shows code blocks.

## Phases

Each phase is its own PR with tests, and the prompt line for a format lands in the
same PR as the format.

1. **Parser + SVG.** `info`/`closed` on code blocks, `visuals` prop,
   Rendered/Code toggle, SVG via `<img>`. No new dependencies.
2. **Mermaid.** `houston-visual://` scheme, render frame entry, Mermaid bundle,
   cache, timeouts, error display, notices/SBOM rows, size measurement.
3. **Interactive HTML.** Document map + IPC, live frames, CSP headers, resize
   protocol, lazy/capped frames, permission handler, the four must-verify tests,
   default-off setting.
4. **Later, separately:** KaTeX math, workspace-relative images in markdown (resolved
   by main inside the roots, never remote), a `check_visual` validation tool if
   failed diagrams turn out to be common.

## Test plan

- Parser: `info` and `closed` across streaming, nested fences, `~~~` fences,
  unclosed at EOF.
- Markdown component: each fence kind's default view, toggle, over-cap fallback,
  `visuals` off in question/elicitation cards, streaming placeholder.
- SVG: `<script>`, `onload=`, `<foreignObject>` and external `href` in an SVG fixture
  produce no execution and no network request (Playwright, network log empty).
- Mermaid: valid diagram renders; malformed shows error + source; 5 s timeout
  recovers; theme switch re-renders; render frame cannot read `window.api`.
- HTML: the hostile fixture suite for the threat table above, run in the Electron
  smoke harness on all three OSes; resize messages from a foreign source are
  ignored; height clamps; fourth frame stays a placeholder.
- Golden: desktop prompt diff contains only the Visuals paragraph.

## Open questions

- Should "Preview" on plain ` ```html ` blocks exist at all, or is the opt-in fence
  enough? It is useful for "build me a landing page" answers, but it is a second
  entry point to the riskiest path.
- Do HTML visuals need a per-conversation or global kill switch beyond the setting
  (for managed/enterprise configs)?
- Is the light "figure card" for SVG acceptable in the dark theme, or should the
  prompt ask for `prefers-color-scheme`-aware SVG (which works inside `<img>`)?
