# Rendering UI mockups and app screenshots (design)

Status: phase 1 built (`show_images`, the gallery, the full-size viewer, and the
media store), phase 2 built (`view_localhost` variants), phase 3 built
(`render_mockup`), phase 4 (compare slider via `compareWith`, prompt line, `render-ui`
skill), and phase 5 (terminal file links). Also built: the viewer's Copy image, Save
image, and Show in Files actions; images sent to the model scaled to 1568 px on the
long side; and an "Image files" badge on `show_images` galleries (only
`view_localhost` and `render_mockup` can vouch for "Running app" or "Mockup from
code"). The opt-in `out` folder for `render_mockup` was replaced by the viewer's
Save image, which needs no write approval because the user picks the file.

Verified for `render_mockup` in the real app with a hostile page: fetch, image,
beacon, WebSocket, `file:` reads, path traversal, iframes outside the root, popups,
geolocation, and dialogs are all blocked or dismissed, and a local listener received
nothing. WebRTC is the one channel the CSP does not cover: on a plain session it sent
STUN packets to the listener; on the mockup session it produced no candidates and no
packets. DNS prefetch was a real leak: Chromium's network log showed it resolving a
`<link rel="dns-prefetch">` host from the mockup page (the response header and a
page-level meta opt-out don't stop explicit links). Houston now starts Chromium with
`--blink-settings=dnsPrefetchingEnabled=false`, and the log then showed no resolution
from the hostile page or from a control page that resolved one before the change. Companion to
[inline-visuals-design.md](inline-visuals-design.md): that doc covers diagrams the
model writes into a reply (Mermaid, SVG, small HTML widgets). This one covers
**pictures of a user interface**: "render how this feature will look", answered with
screenshots of the real app or of a mockup built from code.

## What the user expects

Asked "render how X will look", the agent should come back with images, not prose:

- **From the real app** when it can run: start it, drive it to the right state, capture
  the screens. Labelled "Real app".
- **From code** when the feature doesn't exist yet: write a mockup page (using the
  project's real styles where it can), render it in the states that matter (light and
  dark, empty and error, desktop and mobile), capture each. Labelled "Mockup from code".
- Either way the user sees a captioned gallery in the chat, can open any image full
  size, step through them, compare against today, and find the files on disk.

## What Houston has today

| Piece | Today | Gap |
|---|---|---|
| Capture a web page | `view_localhost` ([viewlocalhost.ts](../src/main/agent/viewlocalhost.ts)): loopback URL only, offscreen window, optional click/fill/wait steps and a selector crop | One fixed 1280×800 viewport, no light/dark or mobile variants, needs a running server, one image per call |
| Approval | `view_localhost` is a network tool, so each call asks | Fine for live servers; heavy for a mockup that never touches the network |
| Show an image | The capture (or a `read_file` image) appears full width inside the tool card | No captions, no gallery, no full-size viewer, no compare, no "real vs mockup" label |
| Images from other pipelines | The agent can run Playwright, a simulator or Storybook through `run_shell` and write PNGs | Nothing shows those files to the user; the agent would have to `read_file` each one |
| Storage | Images are stored as base64 inside the conversation JSON | A gallery of full-size captures would bloat every chat file |
| Terminal client | Text marker only | No way to reach the files |

## Proposal

Three tools, one gallery surface.

### 1. `show_images`: present image files the agent produced

The general escape hatch. Whatever produced the PNGs (a Playwright script against the
Electron app, `xcrun simctl io booted screenshot`, an Android emulator, Storybook,
`view_localhost`, `render_mockup`), the agent calls:

```jsonc
show_images({
  title: "Chat UI today",
  images: [
    { path: "e2e/screens/chat-reply.png", label: "Reply with code blocks" },
    { path: "e2e/screens/approval.png", label: "Approval prompt", compareWith: "e2e/screens/approval-before.png" }
  ]
})
```

- Read-only, no approval. Paths must resolve inside the workspace roots
  (`realpathWithinRoots`), be a real image by magic bytes (PNG, JPEG, WebP, GIF; SVG
  only through `<img>`), at most 12 images and 5 MB each (the existing
  `MAX_ATTACH_IMAGE_BYTES`).
- Images are copied into the conversation's media store (below), so the gallery
  survives the files being deleted or regenerated.
- The model also gets a downscaled copy of each image, so it can check what it is
  showing.
- **Source label is not model-declared.** An image produced in this run by
  `view_localhost` or `render_mockup` gets "Real app" or "Mockup from code" from
  that tool's record; anything else is labelled "Image file". The model cannot
  label a mockup as the real app.

### 2. `view_localhost` variants

Add `variants: [{ label, width, height, colorScheme }]` with presets (`desktop`
1280×800, `tablet` 768×1024, `mobile` 390×844) and `fullPage`. One approval covers
the whole call; each variant is one capture.

### 3. `render_mockup`: capture a page without a server

```jsonc
render_mockup({
  file: "mockups/inline-visuals.html",   // or html: "<inline document>"
  variants: ["desktop-light", "desktop-dark", { label: "Error", query: "?state=error" }]
})
```

- Loads the file in the same offscreen capture engine as `view_localhost`, served
  read-only from the workspace through an internal scheme so relative CSS, fonts and
  images resolve. Script runs (mockups often need it), but in its own session
  partition with **all network blocked**, no preload, permissions denied, navigation
  pinned, a 15 s budget and the same output caps.
- No network and no workspace writes, so it runs without approval under the default
  policy. Writing the PNGs into the workspace (`out: "mockups/"`) is opt-in and goes
  through the normal write approval; by default they go only to the media store.
- Output feeds the gallery directly, labelled "Mockup from code".

### Transcript surface

As drawn in the screenshots:

- **Capture tools** (`render_mockup`, `view_localhost` with variants) render as a
  compact tool card: one line plus a strip of small labelled thumbnails. Today the
  capture fills the card at full width.
- **`show_images`** renders as a gallery card: title, image count, "Compare with
  today" and "Show in Files", and a 2 or 3 column grid of captioned tiles, each with
  its source badge. The model writes text before and after it, so it reads as part of
  the reply.
- **Viewer**: clicking any image opens a full-window viewer with label, source and
  file path, arrows and dots to step through the set, "Show in Files", "Copy image",
  Esc to close. It is keyboard reachable, traps focus, and returns focus to the
  clicked tile.
- **Compare**: for pairs (`compareWith`, or "Compare with today" when an earlier
  gallery in the chat has a matching label) the viewer shows a drag slider between
  Today and Proposed.

### Media store

Images move out of the conversation JSON into
`conversations/<id>/media/<sha256>.<ext>` (0600, same directory permissions as
transcripts), referenced by hash. This deduplicates repeats and keeps chat files small.
Existing chats with inline base64 keep working; a one-time migration is optional.
Deleting a conversation deletes its media folder.

### Terminal client

The CLI lists each image as a clickable file path (OSC 8 hyperlink) with its label
and source, plus a one-line hint to open the chat in the app for the gallery. Inline
images for terminals that support them (kitty, iTerm2 protocols) are a later
addition.

### Teaching the agent

- A desktop system prompt line: when asked to render or show how something looks,
  answer with images; prefer the real app, fall back to a mockup from code, and say
  which is which.
- A built-in skill, `render-ui`, with the decision tree and recipes: web app with a
  dev server (`view_localhost` variants); Electron app (Playwright `_electron` script,
  then `show_images`); iOS simulator (`simctl io screenshot`); no runnable app
  (`render_mockup` with the project's own stylesheet). It also covers driving the app
  to the right state with mock data, capturing the states that matter, and looking at
  every image before showing it.

## Security notes

- `render_mockup` executes workspace HTML and JS. Same threat model as the inline
  HTML visuals: assume hostile content. Isolation comes from a separate session
  partition with a `webRequest` filter that cancels every request outside the
  internal scheme, a deny-all permission handler, no preload, and window-open and
  navigation denied. The WebRTC and DNS-prefetch checks from the inline-visuals doc
  apply here too.
- `show_images` reads files: containment through `realpathWithinRoots`, magic-byte
  type check, size and count caps, and SVG only ever drawn through `<img>`.
- Images can contain secrets (a screenshot of a settings page with a key). They stay
  local like the rest of the transcript. When the model gets a copy, they go to the
  model provider like any `read_file` image today.

## Phases

1. **`show_images` + gallery + viewer + media store.** The biggest win: it works
   with any capture pipeline, including today's `view_localhost`.
2. **`view_localhost` variants** and the compact capture card.
3. **`render_mockup`**, with the isolation tests.
4. **Compare view, `render-ui` skill, prompt line.**
5. **CLI file links.**

## Mockups

Captured from the real Houston app driven by Playwright against a scripted mock model.
Proposed UI was drawn into the running renderer for the screenshots; no product code
changed.

1. Today: the `view_localhost` approval prompt.
2. Today: the capture shown full width inside the tool card.
3. Proposed: the compact render card plus a captioned gallery in the reply.
4. Proposed: the compact render card close up.
5. Proposed: the full-size viewer.
6. Proposed: the Today vs Proposed compare slider.
7. Proposed: real-app screenshots from a Playwright script, shown with `show_images`.
8. Proposed: the terminal client listing images as clickable paths.

## Open questions

- Should `render_mockup` stay approval-free under the "Ask every time" policy, given
  it runs workspace JS (sandboxed, no network)?
- Where should opt-in `out` files go by default: `mockups/` in the repo, or a
  gitignored `.houston/mockups/`?
- Is 12 images per `show_images` call the right cap?
