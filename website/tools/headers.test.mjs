import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Site assets keep the same URL when their content changes, so a long cache lifetime
// means a deploy ships new HTML next to the old app.js / platform.js / styles.css until
// the cache expires (houstoncode.ai once served day-old scripts this way). Every
// Cache-Control rule must therefore make browsers and Cloudflare revalidate.

const headers = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "_headers"),
  "utf8"
);

describe("_headers caching", () => {
  const rules = [...headers.matchAll(/^(\/\S*)\n((?:[ \t]+.*\n?)*)/gm)].map((m) => ({
    path: m[1],
    cache: (m[2].match(/Cache-Control:\s*(.+)/i) || [])[1],
  }));

  it("sets a caching rule for /assets/*", () => {
    expect(rules.find((r) => r.path === "/assets/*")?.cache).toBeTruthy();
  });

  for (const rule of rules.filter((r) => r.cache)) {
    it(`${rule.path} revalidates instead of caching for a fixed time`, () => {
      expect(rule.cache).toMatch(/max-age=0\b/);
      expect(rule.cache).toMatch(/must-revalidate|no-cache/);
    });
  }
});
