# Houston website

The marketing + download site for Houston, served at **houstoncode.ai**.

It's a **static site — no build step, no framework, no dependencies.** Plain HTML,
one stylesheet, one small progressive-enhancement script. The binaries are **not**
hosted here: download buttons resolve to the public
[`houston-releases`](https://github.com/piyushvijay/houston-releases/releases/latest)
GitHub Releases feed, fetched live by `assets/app.js` (with a static fallback link
if the API is unreachable).

## Preview locally

The site uses root-absolute paths (`/assets/…`), so serve it from a web root —
opening `index.html` as a `file://` won't resolve assets.

Faithful Cloudflare Pages preview (recommended — also applies `_redirects`,
`_headers`, and `404.html`, exactly like production):

```
npx wrangler pages dev website          # → http://localhost:8788
```

Quick pages-only preview (zero install; does NOT apply `_redirects`/`_headers`):

```
python3 -m http.server 8000 -d website  # → http://localhost:8000
```

## Layout

```
website/
  index.html          Landing page
  privacy.html        Generated from docs/PRIVACY.md
  404.html            Not-found page (Cloudflare serves this automatically)
  assets/
    styles.css        All styles (theme-aware light/dark)
    app.js            Live release data + platform detection
    icon.png          App icon (copied from build/icon.png)
    og.svg            Social-card source (real icon composited at render time)
    og.png            Social-card render (1200×630), generated from og.svg
    screens/          Real product screenshots (see capture tool below)
  _headers            Cloudflare Pages security + cache headers
  _redirects          /download, /releases, /github short links
  robots.txt          all crawlers welcome, incl. named AI bots (GPTBot, ClaudeBot, …)
  sitemap.xml         homepage + privacy page, with lastmod
  llms.txt            curated product summary for AI assistants (llmstxt.org)
  tools/
    build-legal.mjs       docs/PRIVACY.md → privacy.html
    build-legal.test.mjs  fails CI if the committed HTML drifts from docs/
    build-og.mjs          og.svg → og.png (via the repo's Playwright Chromium)
    capture-screens.mjs   real app screenshots against a local model + demo workspace
```

## Screenshots

`assets/screens/*.png` are real captures of the app, taken against a throwaway
profile, a disposable demo workspace, and a **local** model (Ollama) — so they show
the genuine UI with no API keys, private code, or paid inference. To regenerate:

```
ollama serve &                               # a local model, e.g. `ollama pull llama3.1`
DEMO_DIR=/path/to/a/demo/project \
SHOT_DIR=$PWD/website/assets/screens \
MODEL=llama3.1:latest \
node website/tools/capture-screens.mjs       # needs `npm run build` first
```

Then downsize the retina PNGs for the web (`sips -Z 1600 in.png --out out.png`).
A populated "agent running tools" shot needs a frontier model key — local models
emit text but don't drive Houston's native tool execution.

## Deploy on Cloudflare Pages

Binaries stay on GitHub Releases, so this is a pure static deploy — no build command.

1. **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.**
   Authorize the `piyushvijay/houston` repo.
2. Configure the build:
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `website`
   - **Root directory:** *(leave as repo root)*
3. **Save and Deploy.** Every push to `main` redeploys; pull requests get a preview URL.
4. **Custom domain:** Pages project → **Custom domains → Set up a domain →**
   `houstoncode.ai` (and `www.houstoncode.ai`). If the domain's DNS is already on
   Cloudflare, the records are added for you; TLS is issued automatically.

That's the whole setup — no secrets, no CI wiring.

## Maintenance

- **The privacy page** is generated. After editing `docs/PRIVACY.md`, re-run
  `node website/tools/build-legal.mjs` and commit the updated HTML.
- **Social card:** after editing `assets/og.svg`, re-run `node website/tools/build-og.mjs`.
- **App icon:** if `build/icon.png` changes, `cp build/icon.png website/assets/icon.png`.

## Before it goes public

- [ ] Confirm `houstoncode.ai` is the intended domain (all canonical URLs, the
      sitemap, and OG tags assume it).
- [ ] Optional: add real product screenshots to the landing page.
