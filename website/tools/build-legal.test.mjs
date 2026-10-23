import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildPages, mdToHtml } from "./build-legal.mjs";

// Guards against drift: privacy.html is generated from docs/PRIVACY.md. If someone
// edits the doc (or the generator) without re-running
// `node website/tools/build-legal.mjs`, the committed HTML no longer matches and
// this fails — so the site can't ship a stale Privacy page.
describe("generated pages stay in sync with docs/", () => {
  for (const p of buildPages()) {
    it(`${p.slug} matches its docs/ source`, () => {
      const onDisk = readFileSync(p.out, "utf8");
      expect(onDisk).toBe(p.output);
    });
  }
});

describe("generated page metadata", () => {
  // A shared link to a legal page gets the same social card as the rest of the site.
  for (const p of buildPages()) {
    it(`${p.slug} carries Open Graph and Twitter card tags`, () => {
      const meta = (attr, name) => p.output.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];
      expect(meta("property", "og:url")).toBe(`https://houstoncode.ai/${p.slug}`);
      expect(meta("property", "og:title")).toBe(meta("name", "twitter:title"));
      expect(meta("property", "og:description")).toBe(p.output.match(/<meta name="description" content="([^"]*)"/)[1]);
      expect(meta("property", "og:image")).toBe("https://houstoncode.ai/assets/og.png");
      expect(meta("name", "twitter:card")).toBe("summary_large_image");
    });
  }
});

describe("mdToHtml lists", () => {
  it("joins an item's wrapped lines instead of turning the list into a paragraph", () => {
    const { html } = mdToHtml("- **One.** First line\n  continues here.\n- Two");
    expect(html).toBe("<ul>\n<li><strong>One.</strong> First line continues here.</li>\n<li>Two</li>\n</ul>");
  });

  it("still treats a paragraph that merely contains a dash as a paragraph", () => {
    expect(mdToHtml("Text with - a dash.").html).toBe("<p>Text with - a dash.</p>");
  });
});

describe("mdToHtml inline markup", () => {
  it("renders inline code instead of leaving the backticks in the page", () => {
    expect(mdToHtml("See `SECURITY.md` for details.").html).toBe(
      "<p>See <code>SECURITY.md</code> for details.</p>"
    );
  });

  it("links a bare email address", () => {
    expect(mdToHtml("Or email security@houstoncode.ai.").html).toBe(
      '<p>Or email <a href="mailto:security@houstoncode.ai">security@houstoncode.ai</a>.</p>'
    );
  });
});
