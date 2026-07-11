import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildPages } from "./build-legal.mjs";

// Guards against drift: privacy.html / terms.html are generated from docs/*.md.
// If someone edits the docs (or the generator) without re-running
// `node website/tools/build-legal.mjs`, the committed HTML no longer matches and
// this fails — so the site can't ship a stale Privacy Policy or Terms of Use.
describe("legal pages stay in sync with docs/", () => {
  for (const p of buildPages()) {
    it(`${p.slug} matches its docs/ source`, () => {
      const onDisk = readFileSync(p.out, "utf8");
      expect(onDisk).toBe(p.output);
    });
  }
});
