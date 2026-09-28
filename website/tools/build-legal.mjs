// Generates website/public/privacy.html from the canonical Markdown in docs/. The
// Markdown stays the single source of truth — re-run this after editing
// docs/PRIVACY.md:
//
//     node website/tools/build-legal.mjs
//
// Dependency-free (matches the repo's no-extra-deps convention). Handles the
// small Markdown subset the document uses: h1–h3, bold, links, unordered lists,
// and paragraphs.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SITE = resolve(__dirname, "..", "public");

// Relative links inside the docs → their public destinations.
const LINK_MAP = {
  "PRIVACY.md": "/privacy",
  "../LICENSE": "https://github.com/houston-code/houston/blob/main/LICENSE",
  "../NOTICE": "https://github.com/houston-code/houston/blob/main/NOTICE",
  "sandboxing.md": "https://github.com/houston-code/houston/blob/main/docs/sandboxing.md",
};

const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function inline(text) {
  let out = escapeHtml(text);
  // Links: [label](target)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
    const href = LINK_MAP[target] || target;
    const external = /^https?:/.test(href) && !href.startsWith("/");
    const rel = external ? ' rel="noopener"' : "";
    return `<a href="${href}"${rel}>${label}</a>`;
  });
  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out;
}

export function mdToHtml(md) {
  // Drop the leading HTML maintainer comment block.
  const body = md.replace(/^<!--[\s\S]*?-->\s*/, "");
  const blocks = body.split(/\n{2,}/);
  const parts = [];
  let title = "Houston";

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    if (block.startsWith("### ")) {
      parts.push(`<h3>${inline(block.slice(4))}</h3>`);
    } else if (block.startsWith("## ")) {
      parts.push(`<h2>${inline(block.slice(3))}</h2>`);
    } else if (block.startsWith("# ")) {
      title = block.slice(2).trim();
      parts.push(`<h1>${inline(block.slice(2))}</h1>`);
    } else if (block.startsWith("- ")) {
      // An item runs until the next "- " line, so wrapped (indented) lines join it.
      const items = block
        .split(/\n(?=- )/)
        .map((item) => item.slice(2).split("\n").map((l) => l.trim()).join(" "))
        .map((text) => `<li>${inline(text)}</li>`)
        .join("\n");
      parts.push(`<ul>\n${items}\n</ul>`);
    } else {
      const joined = block.split("\n").map((l) => l.trim()).join(" ");
      const cls = /^\*\*Last updated/.test(block) ? ' class="doc-meta"' : "";
      parts.push(`<p${cls}>${inline(joined)}</p>`);
    }
  }

  return { title, html: parts.join("\n      ") };
}

function page({ title, description, contentTitle, html, slug }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="https://houstoncode.ai/${slug}" />
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0e1116" />
  <link rel="icon" type="image/png" href="/assets/icon.png" />
  <link rel="stylesheet" href="/assets/styles.css" />
  <script src="/assets/theme.js"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="/" aria-label="Houston home">
        <img src="/assets/icon.png" alt="" width="30" height="30" />
        <span>Houston</span>
      </a>
      <nav class="nav" aria-label="Primary">
        <a class="nav-link" href="/#features">Features</a>
        <a class="nav-link" href="/#download">Download</a>
        <a class="nav-link" href="/#faq">FAQ</a>
        <a class="nav-link" href="https://github.com/houston-code/houston" rel="noopener">GitHub</a>
        <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Dark theme" aria-pressed="false" hidden>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <a class="btn btn-primary btn-sm" href="/#download">Download</a>
      </nav>
    </div>
  </header>

  <main id="main" class="legal">
    <div class="wrap">
      <a class="back" href="/">&larr; Back to home</a>
      ${html}
    </div>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <div class="footer-grid">
        <div class="footer-brand">
          <a class="brand" href="/" aria-label="Houston home">
            <img src="/assets/icon.png" alt="" width="30" height="30" />
            <span>Houston</span>
          </a>
          <p>A cross-platform coding agent. Bring your own model.</p>
        </div>
        <nav class="footer-col" aria-labelledby="footer-product">
          <h2 id="footer-product">Product</h2>
          <ul>
            <li><a href="/#features">Features</a></li>
            <li><a href="/#download">Download</a></li>
            <li><a href="/#faq">FAQ</a></li>
            <li><a href="https://github.com/houston-code/houston/releases" rel="noopener">Releases</a></li>
          </ul>
        </nav>
        <nav class="footer-col" aria-labelledby="footer-project">
          <h2 id="footer-project">Project</h2>
          <ul>
            <li><a href="https://github.com/houston-code/houston" rel="noopener">GitHub</a></li>
            <li><a href="https://github.com/houston-code/houston/issues" rel="noopener">Report an issue</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/CONTRIBUTING.md" rel="noopener">Contributing</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/SECURITY.md" rel="noopener">Security policy</a></li>
          </ul>
        </nav>
        <nav class="footer-col" aria-labelledby="footer-legal">
          <h2 id="footer-legal">Legal</h2>
          <ul>
            <li><a href="/privacy">Privacy</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/LICENSE" rel="noopener">License (Apache-2.0)</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/TRADEMARK.md" rel="noopener">Trademark policy</a></li>
          </ul>
        </nav>
        <div class="footer-col">
          <h2>Contact</h2>
          <dl>
            <dt>General</dt><dd><a href="mailto:dev@houstoncode.ai">dev@houstoncode.ai</a></dd>
            <dt>Security</dt><dd><a href="mailto:security@houstoncode.ai">security@houstoncode.ai</a></dd>
            <dt>Privacy</dt><dd><a href="mailto:privacy@houstoncode.ai">privacy@houstoncode.ai</a></dd>
            <dt>Legal</dt><dd><a href="mailto:legal@houstoncode.ai">legal@houstoncode.ai</a></dd>
          </dl>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© <span id="year">2026</span> The Houston Authors</span>
        <span>Not affiliated with NASA.</span>
      </div>
    </div>
  </footer>
  <script src="/assets/app.js" defer></script>
</body>
</html>
`;
}

const DOCS = [
  {
    src: resolve(ROOT, "docs", "PRIVACY.md"),
    out: resolve(SITE, "privacy.html"),
    // Cloudflare Pages serves privacy.html at its extensionless URL (and 308s the
    // .html form there), so the canonical URL is the extensionless one.
    slug: "privacy",
    title: "Houston Privacy",
    description: "How Houston handles your data: it runs on your device, collects no analytics or telemetry, and your data leaves only to the providers you choose.",
  },
];

// Render every generated page in memory (no writes). Used by the CLI below and by
// build-legal.test.mjs, which asserts the committed HTML matches this output —
// so a docs/ edit that isn't regenerated fails CI instead of silently drifting.
export function buildPages() {
  return DOCS.map((doc) => {
    const md = readFileSync(doc.src, "utf8");
    const { html } = mdToHtml(md);
    return { ...doc, output: page({ ...doc, contentTitle: doc.title, html }) };
  });
}

// Only write files when run directly (`node website/tools/build-legal.mjs`).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  mkdirSync(SITE, { recursive: true });
  for (const p of buildPages()) {
    writeFileSync(p.out, p.output);
    console.log(`✓ ${p.out.replace(ROOT + "/", "")}`);
  }
}
