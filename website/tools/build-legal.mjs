// Generates website/privacy.html and website/terms.html from the canonical
// Markdown in docs/. The Markdown stays the single source of truth — re-run
// this after editing docs/PRIVACY.md or docs/TERMS.md:
//
//     node website/tools/build-legal.mjs
//
// Dependency-free (matches the repo's no-extra-deps convention). Handles the
// small Markdown subset those two documents use: h1–h3, bold, links, unordered
// lists, and paragraphs. Maintainer placeholders like [Licensor] are preserved
// and visually flagged so they can't be shipped by accident.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SITE = resolve(__dirname, "..");

// Relative links inside the docs → their public destinations.
const LINK_MAP = {
  "PRIVACY.md": "/privacy.html",
  "TERMS.md": "/terms.html",
  "../LICENSE": "https://github.com/piyushvijay/houston/blob/main/LICENSE",
  "sandboxing.md": "https://github.com/piyushvijay/houston/blob/main/docs/sandboxing.md",
};

const PLACEHOLDERS = ["[Licensor]", "[Governing-law jurisdiction]", "[Dispute venue]"];

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
  // Flag maintainer placeholders so they are obvious on the page.
  for (const ph of PLACEHOLDERS) {
    out = out.split(ph).join(`<span class="placeholder">${ph}</span>`);
  }
  return out;
}

function mdToHtml(md) {
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
    } else if (block.split("\n").every((l) => l.trim().startsWith("- "))) {
      const items = block
        .split("\n")
        .map((l) => `<li>${inline(l.trim().slice(2))}</li>`)
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
  <meta name="theme-color" content="#0d162b" />
  <link rel="icon" type="image/png" href="/assets/icon.png" />
  <link rel="stylesheet" href="/assets/styles.css" />
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
        <a class="nav-link nav-cta btn btn-primary" href="/#download">Get Houston</a>
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
      <div class="footer-bottom">
        <span>© <span id="year">2026</span> Houston ·
          <a href="/privacy.html">Privacy</a> ·
          <a href="/terms.html">Terms</a> ·
          <a href="https://github.com/piyushvijay/houston" rel="noopener">GitHub</a>
        </span>
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
    slug: "privacy.html",
    title: "Houston Privacy Policy",
    description: "How Houston handles your data: it runs on your device, collects no analytics or telemetry from the app, and your data leaves only to the providers you choose.",
  },
  {
    src: resolve(ROOT, "docs", "TERMS.md"),
    out: resolve(SITE, "terms.html"),
    slug: "terms.html",
    title: "Terms of Use — Houston",
    description: "The terms that govern your use of the Houston desktop coding agent.",
  },
];

// Render every legal page in memory (no writes). Used by the CLI below and by
// build-legal.test.mjs, which asserts the committed HTML matches this output —
// so a docs/ edit that isn't regenerated fails CI instead of silently drifting.
export function buildPages() {
  return DOCS.map((doc) => {
    const md = readFileSync(doc.src, "utf8");
    const { html } = mdToHtml(md);
    const flagged = PLACEHOLDERS.filter((ph) => md.includes(ph)).length;
    return { ...doc, output: page({ ...doc, contentTitle: doc.title, html }), flagged };
  });
}

// Only write files when run directly (`node website/tools/build-legal.mjs`).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  mkdirSync(SITE, { recursive: true });
  let flagged = 0;
  for (const p of buildPages()) {
    writeFileSync(p.out, p.output);
    flagged += p.flagged;
    console.log(`✓ ${p.out.replace(ROOT + "/", "")}`);
  }
  if (flagged) {
    console.log(
      `\n⚠  ${flagged} maintainer placeholder(s) present (e.g. [Licensor]). ` +
        `Fill them in the docs/ sources and re-run before the site goes public.`
    );
  }
}
