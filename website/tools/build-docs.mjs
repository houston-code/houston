// Generates houstoncode.ai/docs from docs/houston-guide.md AS OF A RELEASE, so the site
// describes what people can install rather than what is on main. Each `##` section of
// the guide becomes one page (website/public/docs/<slug>.html) beside an index; the
// guide's own intro, written for the agent that loads it as a skill, is left out.
//
//     node website/tools/build-docs.mjs                  # the latest vX.Y.Z tag
//     node website/tools/build-docs.mjs --ref <commit> --version vX.Y.Z
//
// Release - publish runs the second form for a new latest release and carries the result
// to main in its sync PR. build-docs.test.mjs fails CI if the committed pages drift from
// what this generates for the version they record.
//
// Dependency-free, like build-legal.mjs. The Markdown subset is what the guide uses:
// h2-h4, paragraphs, nested lists, fenced code, tables, bold, italics, code spans,
// links, and bare URLs. Anything it can't place (a relative link, say) throws instead
// of shipping a broken page.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { escapeHtml, siteHeader, SITE_FOOTER } from "./site-chrome.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..", "..");
export const DOCS_DIR = resolve(__dirname, "..", "public", "docs");
export const SITEMAP = resolve(__dirname, "..", "public", "sitemap.xml");
export const GUIDE_PATH = "docs/houston-guide.md";
const ORIGIN = "https://houstoncode.ai";

// ---- Source ----

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

// The highest vX.Y.Z among `tags`; pre-release and other tags never count.
export function latestReleaseTag(tags) {
  const key = (t) => t.match(RELEASE_TAG).slice(1).map(Number);
  const releases = tags.filter((t) => RELEASE_TAG.test(t));
  releases.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return releases.at(-1);
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function guideAt(ref) {
  return git("show", `${ref}:${GUIDE_PATH}`);
}

// The commit date of `ref`, YYYY-MM-DD: the docs' sitemap lastmod.
export function dateOf(ref) {
  return git("log", "-1", "--format=%cs", ref).trim();
}

// ---- Markdown ----

// Section slugs drop a heading's parenthetical: "Side chat (/btw)" is /docs/side-chat.
export function slugify(text) {
  return text
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Splits `text` into code spans and the rest, by CommonMark's rule: a span closes at the
// next backtick run of the same length, so "` ```svg `" is a span holding ```svg.
function codeSpans(text) {
  const parts = [];
  let rest = text;
  for (;;) {
    const open = rest.match(/`+/);
    if (!open) break;
    const run = open[0];
    const after = rest.slice(open.index + run.length);
    const close = after.match(new RegExp(`(?<!\`)${run}(?!\`)`));
    if (!close) {
      parts.push({ text: rest.slice(0, open.index + run.length) });
      rest = after;
      continue;
    }
    let code = after.slice(0, close.index);
    if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
    parts.push({ text: rest.slice(0, open.index) }, { code });
    rest = after.slice(close.index + run.length);
  }
  parts.push({ text: rest });
  return parts;
}

function href(target) {
  if (/^(https?:|mailto:)/.test(target)) return target;
  throw new Error(`build-docs: can't place the link target "${target}" on the site; use an absolute URL`);
}

const linkAttrs = (url) => (/^https?:/.test(url) && !url.startsWith(ORIGIN) ? ' rel="noopener"' : "");

const emphasis = (s) =>
  s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)(?<=\S)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1<em>$2</em>");

export function inline(text) {
  // Code spans, links, and bare URLs are held as placeholders while the rest is escaped
  // and emphasized, so `**`/x`**` is bold code and a URL's underscores stay put.
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = codeSpans(text)
    .map((part) => ("code" in part ? hold(`<code>${escapeHtml(part.code)}</code>`) : part.text))
    .join("");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, target) => {
    const url = href(target);
    return hold(`<a href="${escapeHtml(url)}"${linkAttrs(url)}>${emphasis(escapeHtml(label))}</a>`);
  });
  s = s.replace(/https?:\/\/[^\s<>()\u0000]+[^\s<>().,;:!?'"\u0000]/g, (url) =>
    hold(`<a href="${escapeHtml(url)}"${linkAttrs(url)}>${escapeHtml(url)}</a>`)
  );
  s = emphasis(escapeHtml(s));
  while (s.includes("\u0000")) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
  return s;
}

const indentOf = (line) => line.match(/^ */)[0].length;
const LIST_ITEM = /^( *)([-*]|\d+\.) +(.*)$/;
const FENCE = /^( *)(```+)\s*([\w-]*).*$/;
const HEADING = /^(#{2,6}) +(.*?) *#*$/;

function splitRow(line) {
  const cells = [];
  let cell = "";
  for (const part of codeSpans(line.trim().replace(/^\||\|$/g, ""))) {
    if ("code" in part) {
      // GFM unescapes \| inside a table's code spans too (GitHub splits cells first).
      cell += "`" + part.code.replace(/\\\|/g, "|").replace(/\|/g, "\u0001") + "`";
      continue;
    }
    const pieces = part.text.replace(/\\\|/g, "\u0001").split("|");
    cell += pieces.shift();
    for (const p of pieces) {
      cells.push(cell);
      cell = p;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim().replace(/\u0001/g, "|"));
}

// Renders a run of lines (already de-indented) as block HTML. `ctx.headingShift` maps a
// guide heading level to the page's (### is a page's h2); `ctx.ids` dedupes heading ids.
export function blocks(lines, ctx = { headingShift: 1, ids: new Set() }) {
  const html = [];
  let i = 0;
  const startsBlock = (line) =>
    FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || /^\s*\|/.test(line);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const [, pad, ticks, lang] = fence;
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ *${ticks}\`*\\s*$`).test(lines[i])) {
        body.push(lines[i].startsWith(pad) ? lines[i].slice(pad.length) : lines[i].trimStart());
        i++;
      }
      i++;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      html.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(heading[1].length - ctx.headingShift, 6);
      let id = slugify(heading[2]) || "section";
      for (let n = 2; ctx.ids.has(id); n++) id = `${slugify(heading[2])}-${n}`;
      ctx.ids.add(id);
      html.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) {
      if (splitRow(lines[i + 1]).some((c) => c.includes(":"))) {
        throw new Error("build-docs: aligned table columns aren't supported (the site's CSP blocks the inline styles they'd need)");
      }
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      const cells = (tag, row) => row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join("");
      html.push(
        `<div class="table-wrap"><table>\n<thead><tr>${cells("th", head)}</tr></thead>\n<tbody>\n` +
          rows.map((r) => `<tr>${cells("td", r)}</tr>`).join("\n") +
          `\n</tbody>\n</table></div>`
      );
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const indent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const items = [];
      let loose = false;
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM);
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
        const contentIndent = indent + m[0].length - m[1].length - m[3].length;
        const body = [m[3]];
        i++;
        for (; i < lines.length; i++) {
          const next = lines[i];
          if (!next.trim()) {
            // A blank line stays in the item only if the item continues past it.
            const after = lines.slice(i + 1).find((l) => l.trim());
            if (after !== undefined && indentOf(after) > indent) {
              body.push("");
              loose = true;
              continue;
            }
            if (after !== undefined && LIST_ITEM.test(after) && indentOf(after) === indent) loose = true;
            break;
          }
          if (indentOf(next) > indent) {
            body.push(next.slice(Math.min(indentOf(next), contentIndent)));
            continue;
          }
          // A lazy continuation: an unindented line that can't start a block of its own.
          if (!startsBlock(next) && body.at(-1) !== "") {
            body.push(next.trim());
            continue;
          }
          break;
        }
        items.push(body);
        while (i < lines.length && !lines[i].trim()) {
          const after = lines.slice(i + 1).find((l) => l.trim());
          if (after === undefined || !LIST_ITEM.test(after) || indentOf(after) !== indent) break;
          i++;
        }
      }
      const tag = ordered ? "ol" : "ul";
      const lis = items.map((body) => {
        const inner = blocks(body, ctx);
        const tight = !loose && inner.startsWith("<p>") ? inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1") : inner;
        return `<li>${tight}</li>`;
      });
      html.push(`<${tag}>\n${lis.join("\n")}\n</${tag}>`);
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return html.join("\n");
}

// ---- Pages ----

// The guide's `##` sections, in order. The text before the first one (the title and
// the intro addressed to the agent) is dropped.
export function splitGuide(md) {
  const sections = [];
  let inFence = false;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^ *```/.test(line)) inFence = !inFence;
    const h2 = !inFence && line.match(/^## +(.*?) *$/);
    if (h2) {
      sections.push({ title: h2[1], lines: [] });
    } else if (sections.length) {
      sections.at(-1).lines.push(line);
    }
  }
  const seen = new Set();
  for (const s of sections) {
    let slug = slugify(s.title);
    if (!slug || slug === "index") slug = `section-${sections.indexOf(s) + 1}`;
    for (let n = 2; seen.has(slug); n++) slug = `${slugify(s.title)}-${n}`;
    seen.add(slug);
    s.slug = slug;
  }
  return sections;
}

const plain = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// A meta description from a page's first paragraph (or list item, for a page that opens
// with a list), cut at a word near 160 characters.
export function describe(html) {
  const first = html.match(/<p>([\s\S]*?)<\/p>/) || html.match(/<li>([\s\S]*?)<\/li>/);
  const text = first ? plain(first[1]) : "";
  if (text.length <= 160) return text;
  return text.slice(0, 157).replace(/\s+\S*$/, "") + "...";
}

const canonical = (slug) => `${ORIGIN}/docs/${slug === "index" ? "" : slug}`;

// The site groups the guide's sections by topic, in this order (by slug). A section the
// guide adds that isn't listed here lands in "More" at the end, so a release never fails
// on it; build-docs.test.mjs fails until the working-tree guide's sections are all placed.
export const GROUPS = [
  {
    title: "Getting started",
    slugs: ["getting-started-in-the-desktop-app", "what-houston-is", "clients", "models", "settings-and-keys"],
  },
  {
    title: "Working with the agent",
    slugs: [
      "the-terminal-composer",
      "slash-commands",
      "typing-while-it-works",
      "how-long-a-turn-runs",
      "how-hard-the-model-thinks",
      "being-told-when-it-needs-you",
      "running-your-own-commands",
      "remembering-an-instruction",
      "side-chat",
    ],
  },
  {
    title: "Reviewing and undoing changes",
    slugs: [
      "seeing-what-the-tools-did",
      "what-actually-ran",
      "editing-files-while-it-works",
      "undoing-a-turn-and-seeing-what-changed",
      "rewinding-to-an-earlier-message",
      "review-and-multi-step-tools",
      "diagrams-and-visuals-in-replies",
      "code-intelligence",
    ],
  },
  {
    title: "Permissions and safety",
    slugs: ["approval-modes-and-permissions", "shell-sandbox-and-network", "project-rules"],
  },
  {
    title: "Sessions and automation",
    slugs: [
      "context-worktrees-and-history",
      "spawn-separate-sessions",
      "proposed-sessions",
      "watching-work-you-sent-off",
      "scheduled-runs",
    ],
  },
  {
    title: "Extending Houston",
    slugs: ["skills", "custom-subagents", "hooks", "plugins", "mcp-servers", "github-tools"],
  },
  {
    title: "Reference",
    slugs: ["what-a-session-cost", "checking-your-setup", "version-and-updates", "help-menu", "sharing-houston", "license-and-legal"],
  },
];

// `sections` in GROUPS order: [{ title, id, sections }], skipping empty groups.
export function groupSections(sections) {
  const placed = new Set(GROUPS.flatMap((g) => g.slugs));
  const groups = GROUPS.map((g) => ({
    title: g.title,
    sections: g.slugs.map((slug) => sections.find((s) => s.slug === slug)).filter(Boolean),
  }));
  groups.push({ title: "More", sections: sections.filter((s) => !placed.has(s.slug)) });
  return groups.filter((g) => g.sections.length).map((g) => ({ ...g, id: slugify(g.title) }));
}

function sidebar(groups, version, current) {
  const lists = groups
    .map((g) => {
      const links = g.sections
        .map((s) => {
          const here = s.slug === current ? ' aria-current="page"' : "";
          return `            <li><a href="/docs/${s.slug}"${here}>${inline(s.title)}</a></li>`;
        })
        .join("\n");
      return `        <h3 id="nav-${g.id}">${escapeHtml(g.title)}</h3>
        <ul aria-labelledby="nav-${g.id}">
${links}
        </ul>`;
    })
    .join("\n");
  return `<nav class="docs-nav" aria-labelledby="docs-nav-title">
        <h2 id="docs-nav-title"><a href="/docs/"${current === "index" ? ' aria-current="page"' : ""}>Houston docs</a></h2>
        <p class="docs-version">For ${escapeHtml(version)}</p>
${lists}
      </nav>`;
}

function shell({ title, description, slug, version, body, groups }) {
  const url = canonical(slug);
  const ld = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: title,
      description,
      url,
      inLanguage: "en",
      version,
      isPartOf: { "@type": "WebSite", name: "Houston", url: `${ORIGIN}/` },
      about: { "@type": "SoftwareApplication", "@id": `${ORIGIN}/#app`, name: "Houston" },
    },
    null,
    2
  ).replace(/</g, "\\u003c");
  const pageTitle = slug === "index" ? "Houston docs" : `${title} | Houston docs`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="houston-docs-version" content="${escapeHtml(version)}" />
  <link rel="canonical" href="${url}" />
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0e1116" />

  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Houston" />
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${ORIGIN}/assets/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Houston, the open-source AI coding agent: powerful enough to ship, safe enough to trust. Bring your own model." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${ORIGIN}/assets/og.png" />

  <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="stylesheet" href="/assets/styles.css" />
  <script src="/assets/theme.js"></script>
  <script type="application/ld+json">
${ld}
  </script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  ${siteHeader({ current: "docs" })}

  <div class="docs">
    <div class="wrap docs-layout">
      <main id="main" class="docs-content">
${body}
      </main>
      ${sidebar(groups, version, slug)}
    </div>
  </div>

  ${SITE_FOOTER}
  <script src="/assets/app.js" defer></script>
</body>
</html>
`;
}

// The guide names other sections in quotes ("see "Shell sandbox and network""); on the site
// each is its own page, so a quoted title (with or without its parenthetical) links there.
// Code, preformatted text, and existing links are left alone.
export function linkSectionRefs(html, sections, current) {
  const bySlug = new Map();
  for (const s of sections) {
    if (s.slug === current) continue;
    bySlug.set(s.title.toLowerCase(), s.slug);
    bySlug.set(s.title.replace(/\s*\([^)]*\)/g, "").trim().toLowerCase(), s.slug);
  }
  return html.replace(/(<(code|pre|a)\b[\s\S]*?<\/\2>)|&quot;([^&<]{3,80})&quot;/g, (match, skip, _tag, quoted) => {
    if (skip) return skip;
    const slug = bySlug.get(quoted.toLowerCase());
    return slug ? `<a href="/docs/${slug}">&quot;${quoted}&quot;</a>` : match;
  });
}

// Every docs page for the guide `md` as shipped in `version`: [{ file, slug, title, output }].
export function buildDocs(md, version) {
  const sections = splitGuide(md);
  if (!sections.length) throw new Error("build-docs: the guide has no ## sections");
  const groups = groupSections(sections);
  // Reading order (and previous/next) follows the groups, not the guide's order.
  const ordered = groups.flatMap((g) => g.sections);
  const pages = ordered.map((s, n) => {
    const content = linkSectionRefs(blocks(s.lines, { headingShift: 1, ids: new Set() }), sections, s.slug);
    const prev = ordered[n - 1];
    const next = ordered[n + 1];
    const pager = [
      prev ? `<a class="docs-prev" href="/docs/${prev.slug}"><span>Previous</span>${inline(prev.title)}</a>` : "",
      next ? `<a class="docs-next" href="/docs/${next.slug}"><span>Next</span>${inline(next.title)}</a>` : "",
    ].join("");
    // A page with several subsections opens with an "On this page" list of them.
    const subs = [...content.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
    const toc =
      subs.length >= 2
        ? `
        <nav class="docs-toc" aria-labelledby="toc-${s.slug}">
          <h2 id="toc-${s.slug}">On this page</h2>
          <ul>
${subs.map(([, id, title]) => `            <li><a href="#${id}">${title.replace(/<a\b[^>]*>|<\/a>/g, "")}</a></li>`).join("\n")}
          </ul>
        </nav>`
        : "";
    const body = `        <a class="docs-crumb" href="/docs/">Houston docs</a>
        <h1>${inline(s.title)}</h1>${toc}
        <div class="prose">
${content}
        </div>
        <nav class="docs-pager" aria-label="Previous and next topics">${pager}</nav>`;
    return { file: `${s.slug}.html`, slug: s.slug, title: s.title, description: describe(content), body };
  });

  const index = {
    file: "index.html",
    slug: "index",
    title: "Houston docs",
    description: `How to use Houston ${version}: models, approval modes and permissions, the shell sandbox, skills, subagents, hooks, MCP servers, and settings.`,
    body: `        <h1>Houston docs</h1>
        <p class="docs-lede">How to use Houston, the cross-platform coding agent that works with your own model. These pages describe <strong>Houston ${escapeHtml(version)}</strong>, the latest release.</p>
${groups
  .map(
    (g) => `        <section class="docs-group" aria-labelledby="${g.id}">
          <h2 id="${g.id}">${escapeHtml(g.title)}</h2>
          <ul class="docs-topics">
${g.sections
  .map((s) => pages.find((p) => p.slug === s.slug))
  .map((p) => `            <li><a href="/docs/${p.slug}">${inline(p.title)}</a><p>${escapeHtml(p.description)}</p></li>`)
  .join("\n")}
          </ul>
        </section>`
  )
  .join("\n")}`,
  };

  return [index, ...pages].map((p) => ({ ...p, output: shell({ ...p, version, groups }) }));
}

// The sitemap with its /docs entries replaced by `pages`, all dated `lastmod`.
export function withDocsInSitemap(xml, pages, lastmod) {
  const kept = xml.replace(/\n  <url>\n    <loc>https:\/\/houstoncode\.ai\/docs\/[\s\S]*?<\/url>/g, "");
  const entries = pages
    .map(
      (p) => `
  <url>
    <loc>${canonical(p.slug)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>${p.slug === "index" ? "0.8" : "0.5"}</priority>
  </url>`
    )
    .join("");
  return kept.replace(/\n<\/urlset>/, `${entries}\n</urlset>`);
}

// The version the committed pages were built from (the index's houston-docs-version).
export function committedVersion() {
  const index = readFileSync(resolve(DOCS_DIR, "index.html"), "utf8");
  return index.match(/<meta name="houston-docs-version" content="([^"]+)"/)?.[1];
}

export function writeDocs(pages, sitemapDate) {
  mkdirSync(DOCS_DIR, { recursive: true });
  const keep = new Set(pages.map((p) => p.file));
  for (const f of readdirSync(DOCS_DIR)) if (f.endsWith(".html") && !keep.has(f)) rmSync(resolve(DOCS_DIR, f));
  for (const p of pages) writeFileSync(resolve(DOCS_DIR, p.file), p.output);
  writeFileSync(SITEMAP, withDocsInSitemap(readFileSync(SITEMAP, "utf8"), pages, sitemapDate));
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") opts.ref = argv[++i];
    else if (argv[i] === "--version") opts.version = argv[++i];
    else throw new Error(`build-docs: unknown argument ${argv[i]}`);
  }
  if (opts.version && !RELEASE_TAG.test(opts.version)) throw new Error(`build-docs: --version must look like v1.2.3, not ${opts.version}`);
  if (opts.ref && !opts.version) throw new Error("build-docs: --ref needs --version");
  if (opts.ref?.startsWith("-")) throw new Error(`build-docs: --ref must be a commit or ref, not ${opts.ref}`);
  if (!opts.ref) {
    opts.version ??= latestReleaseTag(git("tag", "--list", "v*").split("\n"));
    if (!opts.version) throw new Error("build-docs: no vX.Y.Z tag here; run `git fetch --tags` first");
    opts.ref = `refs/tags/${opts.version}`;
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { ref, version } = parseArgs(process.argv.slice(2));
  const pages = buildDocs(guideAt(ref), version);
  writeDocs(pages, dateOf(ref));
  console.log(`✓ website/public/docs: ${pages.length} pages from ${GUIDE_PATH} at ${version}`);
}
