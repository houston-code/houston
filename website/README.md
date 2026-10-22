# Houston website

The marketing + download site for Houston, served at **houstoncode.ai**.

It's a **static site: no build step, no framework, no dependencies.** Plain HTML,
one stylesheet, one small progressive-enhancement script. The binaries are **not**
hosted here: download buttons resolve to the public
[GitHub Releases feed](https://github.com/houston-code/houston/releases/latest), fetched live by `assets/app.js` (with a static fallback link
if the API is unreachable).

## Preview locally

The site uses root-absolute paths (`/assets/…`), so serve it from a web root;
opening `public/index.html` as a `file://` won't resolve assets.

Faithful Cloudflare Pages preview (recommended; it also applies `_redirects`,
`_headers`, and `404.html`, exactly like production):

```
npx wrangler pages dev website/public   # → http://localhost:8788
```

Quick pages-only preview (zero install; does NOT apply `_redirects`/`_headers`):

```
python3 -m http.server 8000 -d website/public  # → http://localhost:8000
```

## Layout

Everything under `public/` is deployed, and nothing else is. This README and
`tools/` sit outside it so they are never served.

```
website/
  README.md           This file (not deployed)
  public/             The deployed site (Cloudflare Pages output directory)
    index.html          Landing page
    privacy.html        Generated from docs/PRIVACY.md
    docs/               Generated from docs/houston-guide.md at the latest release (see Docs below)
    contact.html        Contact addresses (GitHub issues first, then email by topic)
    404.html            Not-found page (Cloudflare serves this automatically)
    favicon.ico         Tab icon, 16/32/48 px (generated from assets/icon.png)
    apple-touch-icon.png  180 px iOS / Safari favorites icon (generated)
    apple-touch-icon-precomposed.png  the same size under the legacy name older iOS
                        requests without a link tag (not generated; replace by hand)
    assets/
      styles.css        All styles; its header documents the design tokens
      theme.js          Light/dark toggle (follows the OS until a visitor picks one)
      app.js            Live release data + applies the platform recommendation
      platform.js       Which download card fits the visitor (pure, tested in tools/)
      icon.png          App icon (copied from build/icon.png)
      icon-60.png       Header/footer logo, 60 px for 30 px CSS (generated from icon.png)
      og.svg            Social-card source (real icon composited at render time)
      og.png            Social-card render (1200×630), generated from og.svg
      screens/          Real product screenshots (see capture tool below), PNG + WebP widths
    _headers            Cloudflare Pages security + cache headers
    _redirects          /download, /releases, /github short links
    robots.txt          all crawlers welcome, incl. named AI bots (GPTBot, ClaudeBot, …)
    sitemap.xml         homepage, contact, privacy, and docs pages, with lastmod (docs entries generated)
    llms.txt            curated product summary for AI assistants (llmstxt.org)
  tools/              Build scripts (not deployed)
    site-chrome.mjs       the header and footer the generated pages share
    build-legal.mjs       docs/PRIVACY.md → privacy.html
    build-legal.test.mjs  fails CI if the committed HTML drifts from docs/
    build-docs.mjs        docs/houston-guide.md at a release → docs/*.html + sitemap entries
    build-docs.test.mjs   fails CI if the pages drift from their release's guide, or if the
                          working-tree guide uses Markdown the generator can't render
    download-links.test.mjs  fails CI if a download link's asset suffix matches no build (or the CLI)
    platform.test.mjs     platform.js recommendations for each browser/OS/CPU
    app.test.mjs          app.js on the real page: hero button downloads the detected build, else scrolls
    headers.test.mjs      assets revalidate on every use (no fixed cache lifetime; files keep their names)
    palette.test.mjs      no colors outside the design tokens; every text pairing clears WCAG AA
    build-og.mjs          og.svg → og.png (via the repo's Playwright Chromium)
    build-favicons.mjs    assets/icon.png → favicon.ico, apple-touch-icon.png, assets/icon-60.png
    build-screens.mjs     screens/models-*.png → 800/1200/1600 px WebP for the hero srcset
    screens.test.mjs      fails CI if the hero srcset and the WebP files drift apart
    favicons.test.mjs     fails CI if a page's icon links or icon files drift
    capture-screens.mjs   real app screenshots against a local model + demo workspace
```

## Screenshots

`public/assets/screens/*.png` are real captures of the app, taken against a throwaway
profile, a disposable demo workspace, and a **local** model (Ollama), so they show
the genuine UI with no API keys, private code, or paid inference. To regenerate:

```
ollama serve &                               # a local model, e.g. `ollama pull llama3.1`
DEMO_DIR=/path/to/a/demo/project \
SHOT_DIR=$PWD/website/public/assets/screens \
MODEL=llama3.1:latest \
node website/tools/capture-screens.mjs       # needs `npm run build` first
```

Then downsize the retina PNGs for the web (`sips -Z 1600 in.png --out out.png`).
The landing page shows `screens/models-dark.png` or `screens/models-light.png` to
match the page's theme (from `shot-modelpicker-dark.png` / `-light.png`), so
regenerate both together. Then re-run `build-screens.mjs` to re-encode the WebP
widths the hero's `srcset` serves (the PNGs stay as the fallback), and re-run
`build-og.mjs`, since `assets/og.png` embeds the dark one.
A populated "agent running tools" shot needs a frontier model key: local models
emit text but don't drive Houston's native tool execution.

## Deploy on Cloudflare Pages

Binaries stay on GitHub Releases, so this is a pure static deploy with no build command.

1. **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.**
   Authorize the `houston-code/houston` repo.
2. Configure the build:
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `website/public`
   - **Root directory:** *(leave as repo root)*
3. **Save and Deploy.** Every push to `main` redeploys; pull requests get a preview URL.
4. **Custom domain:** Pages project → **Custom domains → Set up a domain →**
   `houstoncode.ai` (and `www.houstoncode.ai`). If the domain's DNS is already on
   Cloudflare, the records are added for you; TLS is issued automatically.

That's the whole setup: no secrets, no CI wiring.

## Design system

The site uses a deliberately small set of values, defined at the top of
`public/assets/styles.css`: five neutrals and five blues per theme, five type sizes,
and two corner radii. Build new UI from those rather than adding values;
`tools/palette.test.mjs` fails on any color outside the tokens and on any text pairing
below 4.5:1 in either theme.

The header, footer, and theme script are repeated in `index.html`, `404.html`,
`contact.html`, and `tools/site-chrome.mjs` (used by the generated pages). Change them
together, then re-run both generators.

## Docs

`/docs` is the product guide (`docs/houston-guide.md`) as of the **latest release**, not
`main`, so it describes what people can install. Each `##` section is one page; the guide's
intro, written for the agent that loads it as a skill, is left out. The app's
**Help → Houston Guide** opens `/docs/`.

- **On release:** Release - publish rebuilds the pages from the release commit for a
  release marked latest and carries them to `main` in its sync PR. Nothing to do by hand.
- **By hand** (after changing the generator, the chrome, or to recover a failed sync):
  `node website/tools/build-docs.mjs` builds from the highest local `vX.Y.Z` tag
  (`git fetch --tags` first). Commit `public/docs/` and `public/sitemap.xml`.
- **Editing the guide** on `main` changes the site at the next release. Use only the
  Markdown the generator supports (headings, paragraphs, lists, tables without alignment,
  fenced code, emphasis, code spans, absolute links); the test fails on anything else.
- **Page URLs** come from section headings, minus any parenthetical. Renaming a heading
  moves its page.
- **Topic groups** (the index sections, the sidebar, and previous/next order) are `GROUPS`
  in `build-docs.mjs`. A new `##` section must be added to a group; the test fails until it
  is. At release time an unplaced section lands in a "More" group rather than failing.

## Maintenance

- **The privacy page** is generated. After editing `docs/PRIVACY.md`, re-run
  `node website/tools/build-legal.mjs` and commit the updated HTML.
- **Social card:** after editing `public/assets/og.svg`, re-run `node website/tools/build-og.mjs`.
- **App icon:** if `build/icon.png` changes, `cp build/icon.png website/public/assets/icon.png`,
  then re-run `node website/tools/build-favicons.mjs` to regenerate `favicon.ico` (16/32/48),
  `apple-touch-icon.png`, and the 60 px header logo `assets/icon-60.png` from it.
