/**
 * Body of the built-in `render-ui` skill: how to answer "show me how this looks" (or
 * "how it will look") with images. Offered only where `show_images` is, the desktop
 * app; see BUILTIN_SKILLS in skills.ts.
 */
export const RENDER_UI_SKILL = `# Rendering how a UI looks

Use this when the user asks to see, preview, render, or mock up how something looks
or will look: a screen, a component, a before and after, a set of states. Answer with
images, not a description of them.

## 1. Decide the source

- **The real app**, whenever it can run and already has what the user wants to see.
  Real screenshots are worth more than mockups. Use them for "how does it look now",
  for checking a change you made, and for before and after.
- **A mockup from code**, when the feature does not exist yet or the app cannot run
  here (missing services, credentials, hardware). Build it from the project's own
  styles so it looks like the product, not a generic page.

Say which you are doing before you start if the user might expect the other.

## 2. Capture

Images you want to show must be files inside the project (show_images only reads
there). Put them in a folder the project ignores, such as one already listed in
.gitignore, or tell the user which folder you created so it doesn't end up in a
commit by accident. Never commit screenshots unless the user asks.

**Web app with a dev server.** Start the server with run_shell (background: true),
then call view_localhost. Without variants it takes one capture; with variants (for
example desktop light, desktop dark, and mobile) it captures each from a fresh load
and the user sees them as a gallery marked as the running app, so you don't need
show_images after it. For flows across several pages, or files you want to keep,
write a short Playwright script that saves PNGs, run it with run_shell, then show
them with show_images.

**Electron app.** Build it, then a Playwright script with \`_electron.launch\` opens the
built app; size the window, drive it to the state you need (with test or mock data,
never the user's real accounts), and call \`page.screenshot\`.

**iOS simulator.** \`xcrun simctl io booted screenshot <file>.png\` after launching the
app in a booted simulator.

**Android emulator.** \`adb exec-out screencap -p > <file>.png\`.

**Mockup from code.** Write an HTML page inside the project that links or inlines the
project's real stylesheet and theme tokens, and reuses real class names and copy
where they exist. If render_mockup is available, render it with that: it needs no
server or browser install, takes presets like desktop, tablet, and mobile in light or
dark, and shows the result as a gallery labelled as a mockup, so you don't call
show_images after it. The page can load its own CSS, fonts, images, and scripts from
the project but nothing from the network, so don't link fonts or libraries from a CDN.
To show several states from one file, have the page read \`location.search\` and pass a
query per variant (for example "?state=empty"). Without render_mockup, render the page
with a headless browser script (Playwright's chromium) and show the files.

Installing a browser for Playwright downloads it, which needs network access the
user may have to approve. Use what the project already has before adding anything.

## 3. Cover the states that matter

Pick the few that answer the question, usually 2 to 6: light and dark theme, desktop
and mobile width, empty, loading, error, and the populated state. For a change, show
before and after of the same state at the same size: capture the "before" first and
pass it as compareWith on the "after" image in show_images, so the user can drag a
slider between the two.

## 4. Check, then show

Look at every image before you present it: a blank page, an error overlay, a
half-loaded state, or a cropped element means the capture failed, so fix it and
recapture. Then call show_images with a title and a short label per image, and a
caption where one helps (render_mockup results are already shown).

In your reply, say plainly which images come from the running app and which are
mockups, and what a mockup leaves out (fake data, controls that aren't wired up).
`
