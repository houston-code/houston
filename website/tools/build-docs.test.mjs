import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ROOT,
  DOCS_DIR,
  SITEMAP,
  GUIDE_PATH,
  blocks,
  buildDocs,
  committedVersion,
  describe as describePage,
  guideAt,
  inline,
  latestReleaseTag,
  linkSectionRefs,
  slugify,
  splitGuide,
  withDocsInSitemap,
} from "./build-docs.mjs";

// The guide at the version the committed pages record. CI's checkout is shallow and has no
// tags, so the tag's commit is fetched (the repo is public); off CI with no network the
// drift check says so and skips rather than failing a local run.
function committedSource(version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version || "")) return undefined;
  try {
    return guideAt(`refs/tags/${version}`);
  } catch {
    try {
      execFileSync("git", ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", `refs/tags/${version}`], { cwd: ROOT, stdio: "ignore" });
      return guideAt("FETCH_HEAD");
    } catch (err) {
      if (process.env.CI) throw err;
      return undefined;
    }
  }
}

const html = (file) => readFileSync(resolve(DOCS_DIR, file), "utf8");
// Page text outside code, with tags and entities gone: where unconverted Markdown would show.
const visibleText = (page) =>
  page
    .replace(/<pre>[\s\S]*?<\/pre>/g, "")
    .replace(/<code>[\s\S]*?<\/code>/g, "")
    .replace(/<(head|script)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, " ");

describe("committed docs pages", () => {
  const version = committedVersion();

  it("record the release they were built from", () => {
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  const source = committedSource(version);
  it.skipIf(!source)(`match ${GUIDE_PATH} at their release (re-run website/tools/build-docs.mjs)`, () => {
    const pages = buildDocs(source, version);
    expect(readdirSync(DOCS_DIR).filter((f) => f.endsWith(".html")).sort()).toEqual(pages.map((p) => p.file).sort());
    for (const p of pages) expect(html(p.file), p.file).toBe(p.output);
  });

  it("are all in the sitemap, and nothing else under /docs is", () => {
    const sitemap = readFileSync(SITEMAP, "utf8");
    const listed = [...sitemap.matchAll(/<loc>https:\/\/houstoncode\.ai\/docs\/([^<]*)<\/loc>/g)].map((m) => m[1] || "index");
    const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
    expect(listed.sort()).toEqual(files.sort());
  });

  it("link only to pages that exist", () => {
    const files = new Set(readdirSync(DOCS_DIR));
    for (const f of files) {
      for (const [, slug] of html(f).matchAll(/href="\/docs\/([^"#]*)"/g)) {
        expect(files.has(`${slug || "index"}.html`), `${f} links /docs/${slug}`).toBe(true);
      }
    }
  });
});

describe("the working-tree guide", () => {
  // The next release's guide is today's: a construct the generator can't render fails
  // here, on the PR that adds it, instead of in Release - publish.
  const pages = buildDocs(readFileSync(resolve(ROOT, GUIDE_PATH), "utf8"), "v0.0.0");

  it("renders with no Markdown left in the page text", () => {
    for (const p of pages.filter((p) => p.slug !== "index")) {
      const text = visibleText(p.output.match(/<main[\s\S]*<\/main>/)[0]);
      expect(text, p.file).not.toMatch(/\*\*|\]\(|```|(^|\s)#{2,} |\u0000/);
      expect(text, p.file).not.toMatch(/^\s*[-*] /m);
    }
  });

  it("gives every page a title, a description, and a canonical URL", () => {
    for (const p of pages) {
      expect(p.output).toMatch(/<title>[^<]+<\/title>/);
      expect(p.description.length, p.file).toBeGreaterThan(20);
      expect(p.description.length, p.file).toBeLessThanOrEqual(160);
      expect(p.output).toContain(`<link rel="canonical" href="https://houstoncode.ai/docs/${p.slug === "index" ? "" : p.slug}" />`);
    }
  });

  it("has no em dashes in what visitors read", () => {
    for (const p of pages) expect(visibleText(p.output), p.file).not.toContain("—");
  });
});

describe("latestReleaseTag", () => {
  it("compares versions numerically and ignores other tags", () => {
    expect(latestReleaseTag(["v0.9.0", "v0.10.0", "v0.10.1-rc.1", "v0.8.3", "nightly", ""])).toBe("v0.10.0");
  });
  it("is undefined with no release tags", () => {
    expect(latestReleaseTag(["nightly"])).toBeUndefined();
  });
});

describe("slugify", () => {
  it("drops parentheticals and punctuation", () => {
    expect(slugify("Side chat (/btw)")).toBe("side-chat");
    expect(slugify("Context, worktrees, and history")).toBe("context-worktrees-and-history");
    expect(slugify("Running your own commands (!)")).toBe("running-your-own-commands");
  });
});

describe("splitGuide", () => {
  it("drops the intro, keeps ## sections in order, and ignores ## inside code", () => {
    const md = "# Title\n\nFor the agent.\n\n## One\n\nA\n\n```markdown\n## not a section\n```\n\n## One (again)\n\nB\n";
    const sections = splitGuide(md);
    expect(sections.map((s) => [s.title, s.slug])).toEqual([
      ["One", "one"],
      ["One (again)", "one-2"],
    ]);
    expect(sections[0].lines.join("\n")).toContain("## not a section");
  });
});

describe("inline", () => {
  it("renders bold code spans and code spans holding backtick runs", () => {
    expect(inline("**`/undo`** and ` ```svg ` blocks")).toBe("<strong><code>/undo</code></strong> and <code>```svg</code> blocks");
  });
  it("leaves Markdown inside code alone", () => {
    expect(inline("deny `*rm -rf*` and `a_b_c`")).toBe("deny <code>*rm -rf*</code> and <code>a_b_c</code>");
  });
  it("escapes HTML in text and code", () => {
    expect(inline('a <b> & "c" `<i>`')).toBe("a &lt;b&gt; &amp; &quot;c&quot; <code>&lt;i&gt;</code>");
  });
  it("links Markdown links and bare URLs, leaving trailing punctuation out", () => {
    expect(inline("See [the *site*](https://example.com/a_b) or https://example.com/x.")).toBe(
      'See <a href="https://example.com/a_b" rel="noopener">the <em>site</em></a> or <a href="https://example.com/x" rel="noopener">https://example.com/x</a>.'
    );
  });
  it("doesn't mark the site's own links noopener", () => {
    expect(inline("https://houstoncode.ai")).toBe('<a href="https://houstoncode.ai">https://houstoncode.ai</a>');
  });
  it("refuses a relative link it can't place on the site", () => {
    expect(() => inline("[rules](../SECURITY.md)")).toThrow(/absolute URL/);
  });
  it("leaves snake_case words alone but italicizes _phrases_", () => {
    expect(inline("max_turns and _this_")).toBe("max_turns and <em>this</em>");
  });
});

describe("blocks", () => {
  const render = (md) => blocks(md.split("\n"), { headingShift: 1, ids: new Set() });

  it("nests lists, joins wrapped and lazy lines, and keeps tight items unwrapped", () => {
    const md = [
      "- **One.** First line",
      "  continues here.",
      "  - Nested item",
      "    wraps.",
      "- Two",
      "lazy continuation.",
    ].join("\n");
    expect(render(md)).toBe(
      "<ul>\n<li><strong>One.</strong> First line continues here.\n<ul>\n<li>Nested item wraps.</li>\n</ul></li>\n<li>Two lazy continuation.</li>\n</ul>"
    );
  });

  it("wraps items in paragraphs when the list has blank lines", () => {
    expect(render("- One\n\n- Two")).toBe("<ul>\n<li><p>One</p></li>\n<li><p>Two</p></li>\n</ul>");
  });

  it("renders ordered lists", () => {
    expect(render("1. First\n2. Second")).toBe("<ol>\n<li>First</li>\n<li>Second</li>\n</ol>");
  });

  it("renders tables, keeping pipes inside code and escaped pipes in their cell", () => {
    const md = "| Key | Does |\n| --- | --- |\n| `a|b` | x \\| y |";
    expect(render(md)).toBe(
      '<div class="table-wrap"><table>\n<thead><tr><th>Key</th><th>Does</th></tr></thead>\n<tbody>\n<tr><td><code>a|b</code></td><td>x | y</td></tr>\n</tbody>\n</table></div>'
    );
  });

  it("refuses aligned table columns (they'd need inline styles)", () => {
    expect(() => render("| a |\n| :---: |\n| b |")).toThrow(/aligned/);
  });

  it("escapes fenced code and keeps its language", () => {
    expect(render("```json\n{ \"a\": \"<b>\" }\n```")).toBe('<pre><code class="language-json">{ &quot;a&quot;: &quot;&lt;b&gt;&quot; }</code></pre>');
  });

  it("shifts headings down a level and gives them unique ids", () => {
    expect(render("### Fallback models\n\n### Fallback models\n\n#### Detail")).toBe(
      '<h2 id="fallback-models">Fallback models</h2>\n<h2 id="fallback-models-2">Fallback models</h2>\n<h3 id="detail">Detail</h3>'
    );
  });
});

describe("page metadata", () => {
  it("describes a page by its first paragraph, cut at a word", () => {
    const long = "word ".repeat(60).trim();
    const d = describePage(`<p>${long}</p>`);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.endsWith("word...")).toBe(true);
    expect(describePage("<p>Short <code>x</code> &amp; sweet.</p>")).toBe("Short x & sweet.");
  });

  it("escapes the version and description into attributes and JSON-LD safely", () => {
    const [index, page] = buildDocs('## A "quoted" </script> topic\n\nBody with "quotes" </script>.\n', "v1.2.3");
    expect(index.output).toContain('<meta name="houston-docs-version" content="v1.2.3" />');
    expect(page.output).toContain('content="Body with &quot;quotes&quot; &lt;/script&gt;."');
    const ld = page.output.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    expect(ld).not.toContain("</");
    expect(JSON.parse(ld).headline).toBe('A "quoted" </script> topic');
  });

  it("links neighbors and marks the current topic", () => {
    const [, one, two] = buildDocs("## One\n\nA.\n\n## Two\n\nB.\n", "v1.0.0");
    expect(one.output).toContain('<a class="docs-next" href="/docs/two">');
    expect(one.output).not.toContain("docs-prev");
    expect(two.output).toContain('<a class="docs-prev" href="/docs/one">');
    expect(two.output).toContain('<a href="/docs/two" aria-current="page">Two</a>');
  });
});

describe("linkSectionRefs", () => {
  const sections = [
    { title: "What actually ran (the receipt)", slug: "what-actually-ran" },
    { title: "Hooks", slug: "hooks" },
  ];

  it("links a quoted section title, with or without its parenthetical", () => {
    expect(linkSectionRefs("<p>See &quot;What actually ran&quot; and &quot;hooks&quot;.</p>", sections, "other")).toBe(
      '<p>See <a href="/docs/what-actually-ran">&quot;What actually ran&quot;</a> and <a href="/docs/hooks">&quot;hooks&quot;</a>.</p>'
    );
  });

  it("leaves code, links, the current page, and unknown quotes alone", () => {
    const html = '<p><code>&quot;Hooks&quot;</code> <a href="x">&quot;Hooks&quot;</a> &quot;Nope&quot;</p>';
    expect(linkSectionRefs(html, sections, "other")).toBe(html);
    expect(linkSectionRefs("<p>&quot;Hooks&quot;</p>", sections, "hooks")).toBe("<p>&quot;Hooks&quot;</p>");
  });
});

describe("withDocsInSitemap", () => {
  const base = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://houstoncode.ai/</loc>\n  </url>\n</urlset>\n';
  const pages = [{ slug: "index" }, { slug: "models" }];

  it("adds the docs pages once, however often it runs", () => {
    const once = withDocsInSitemap(base, pages, "2026-10-21");
    expect(withDocsInSitemap(once, pages, "2026-10-21")).toBe(once);
    expect(once).toContain("<loc>https://houstoncode.ai/docs/</loc>");
    expect(once).toContain("<loc>https://houstoncode.ai/docs/models</loc>");
    expect(once).toContain("<loc>https://houstoncode.ai/</loc>");
  });

  it("drops pages a newer guide no longer has", () => {
    const once = withDocsInSitemap(base, pages, "2026-10-21");
    const next = withDocsInSitemap(once, [{ slug: "index" }], "2026-11-01");
    expect(next).not.toContain("/docs/models");
    expect(next).toContain("<lastmod>2026-11-01</lastmod>");
  });
});
