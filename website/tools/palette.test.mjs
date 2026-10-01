import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The site draws every color from ten tokens per theme (five neutrals, five blues), as
// the header of styles.css describes. This keeps that true: no raw colors outside the
// token blocks, the two copies of the dark theme stay identical, and every text pairing
// the stylesheet uses clears WCAG AA in both themes.

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, "..", "public", "assets", "styles.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const TOKENS = ["n1", "n2", "n3", "n4", "n5", "a1", "a2", "a3", "a4", "a5"];
// Text on the solid accent (primary button, skip link) is white in both themes.
const ON_ACCENT = "#ffffff";

function block(selector) {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`styles.css has no "${selector}" block`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function tokens(body) {
  return Object.fromEntries([...body.matchAll(/--([an]\d):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

const light = tokens(block(":root"));
const dark = tokens(block(':root[data-theme="dark"]'));
const darkBySystem = tokens(block(':root:not([data-theme="light"])'));

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("site palette", () => {
  it("defines exactly the ten tokens in each theme", () => {
    expect(Object.keys(light).sort()).toEqual([...TOKENS].sort());
    expect(Object.keys(dark).sort()).toEqual([...TOKENS].sort());
  });

  it("keeps the OS-dark and pinned-dark themes identical", () => {
    expect(darkBySystem).toEqual(dark);
  });

  it("uses no raw colors outside the token blocks", () => {
    const rules = css.replace(/--[\w-]+:\s*[^;]+;/g, "");
    const colors = [...rules.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/gi)].map((m) => m[0].toLowerCase());
    expect(colors.filter((c) => c !== "#fff" && c !== ON_ACCENT)).toEqual([]);
  });

  for (const [name, t] of [["light", light], ["dark", dark]]) {
    describe(`${name} theme`, () => {
      const text = [
        ["primary text on page", t.n5, t.n1],
        ["primary text on surface", t.n5, t.n2],
        ["secondary text on page", t.n4, t.n1],
        ["secondary text on surface", t.n4, t.n2],
        ["secondary text on accent tint", t.n4, t.a1],
        ["link on page", t.a5, t.n1],
        ["link on surface", t.a5, t.n2],
        ["link on accent tint", t.a5, t.a1],
        ["button label on accent", ON_ACCENT, t.a3],
        ["button label on hovered accent", ON_ACCENT, t.a4],
      ];
      for (const [label, fg, bg] of text) {
        it(`${label} clears 4.5:1`, () => {
          expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
        });
      }

      it("focus ring and primary button clear 3:1 against the page", () => {
        expect(contrast(t.a3, t.n1)).toBeGreaterThanOrEqual(3);
        expect(contrast(t.a3, t.n2)).toBeGreaterThanOrEqual(3);
      });
    });
  }
});
