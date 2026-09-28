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

describe("mdToHtml lists", () => {
  it("joins an item's wrapped lines instead of turning the list into a paragraph", () => {
    const { html } = mdToHtml("- **One.** First line\n  continues here.\n- Two");
    expect(html).toBe("<ul>\n<li><strong>One.</strong> First line continues here.</li>\n<li>Two</li>\n</ul>");
  });

  it("still treats a paragraph that merely contains a dash as a paragraph", () => {
    expect(mdToHtml("Text with - a dash.").html).toBe("<p>Text with - a dash.</p>");
  });
});
