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
import { siteHeader, SITE_FOOTER } from "./site-chrome.mjs";

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
  // Inline code: `text`
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bare email addresses become mailto links.
  out = out.replace(
    /(^|[\s(])([\w.+-]+@[\w-]+(?:\.[\w-]+)+\b)/g,
    '$1<a href="mailto:$2">$2</a>'
  );
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

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Houston" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="https://houstoncode.ai/${slug}" />
  <meta property="og:image" content="https://houstoncode.ai/assets/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Houston, the open-source AI coding agent: powerful enough to ship, safe enough to trust. Bring your own model." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="https://houstoncode.ai/assets/og.png" />

  <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="stylesheet" href="/assets/styles.css" />
  <script src="/assets/theme.js"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  ${siteHeader()}

  <main id="main" class="legal">
    <div class="wrap">
      <a class="back" href="/">&larr; Back to home</a>
      ${html}
    </div>
  </main>

  ${SITE_FOOTER}
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
