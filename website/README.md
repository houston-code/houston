# Houston website

The marketing + download site for Houston, served at **houstoncode.ai**.

It's a **static site — no build step, no framework, no dependencies.** Plain HTML,
one stylesheet, one small progressive-enhancement script. The binaries are **not**
hosted here: download buttons resolve to the public
[`houston-releases`](https://github.com/piyushvijay/houston-releases/releases/latest)
GitHub Releases feed, fetched live by `assets/app.js` (with a static fallback link
if the API is unreachable).

## Layout

```
website/
  index.html          Landing page
  privacy.html        Generated from docs/PRIVACY.md
  terms.html          Generated from docs/TERMS.md
  404.html            Not-found page (Cloudflare serves this automatically)
  assets/
    styles.css        All styles (theme-aware light/dark)
    app.js            Live release data + platform detection
    icon.png          App icon (copied from build/icon.png)
    og.svg            Social-card source
    og.png            Social-card render (1200×630), generated from og.svg
  _headers            Cloudflare Pages security + cache headers
  _redirects          /download, /releases, /github short links
  robots.txt, sitemap.xml
  tools/
    build-legal.mjs   docs/*.md → privacy.html / terms.html
    build-og.mjs      og.svg → og.png (via the repo's Playwright Chromium)
```

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

- **Legal pages** are generated. After editing `docs/PRIVACY.md` or `docs/TERMS.md`,
  re-run `node website/tools/build-legal.mjs` and commit the updated HTML.
- **Social card:** after editing `assets/og.svg`, re-run `node website/tools/build-og.mjs`.
- **App icon:** if `build/icon.png` changes, `cp build/icon.png website/assets/icon.png`.

## Before it goes public

- [ ] **Fill the legal placeholders.** `docs/PRIVACY.md` and `docs/TERMS.md` still
      contain `[Licensor]`, `[Governing-law jurisdiction]`, and `[Dispute venue]`.
      Fill them in the docs, re-run `build-legal.mjs`, and have a lawyer review.
      The generated pages highlight these in yellow so they can't ship unnoticed.
- [ ] Confirm `houstoncode.ai` is the intended domain (all canonical URLs, the
      sitemap, and OG tags assume it).
- [ ] Optional: add real product screenshots to the landing page.
