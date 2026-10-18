import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SHOTS, WIDTHS } from "./build-screens.mjs";

// Guards the hero screenshot's responsive <picture>: every srcset entry points at a real
// WebP whose pixel width matches its `w` descriptor (a stale or mislabelled file makes
// browsers pick the wrong size), every encoded width is offered, and the light/dark
// split that theme.js drives survives.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");
const html = readFileSync(resolve(PUBLIC, "index.html"), "utf8");
const picture = html.match(/<figure class="shot">[\s\S]*?<\/picture>/)[0];
const sources = [...picture.matchAll(/<source\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// Pixel size from a WebP's first chunk (lossy VP8, lossless VP8L, or extended VP8X).
function webpSize(buf) {
  expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X") return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  throw new Error(`unknown WebP chunk ${chunk}`);
}

const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

describe("hero screenshot", () => {
  const webpSources = sources.filter((s) => attr(s, "type") === "image/webp");
  const entries = webpSources.flatMap((s) =>
    attr(s, "srcset").split(",").map((e) => {
      const [url, w] = e.trim().split(/\s+/);
      return { url, width: Number(w.replace(/w$/, "")) };
    })
  );

  it("offers a WebP srcset per theme, each with sizes", () => {
    expect(webpSources).toHaveLength(SHOTS.length);
    for (const s of webpSources) expect(attr(s, "sizes")).toBeTruthy();
  });

  it("lists every encoded shot at every width", () => {
    const expected = SHOTS.flatMap((shot) => WIDTHS.map((w) => `/assets/screens/${shot}-${w}.webp ${w}`));
    expect(entries.map((e) => `${e.url} ${e.width}`).sort()).toEqual(expected.sort());
  });

  it.each(entries.map((e) => [e.url, e]))("%s is a WebP of its stated width", (_, { url, width }) => {
    const file = resolve(PUBLIC, url.slice(1));
    expect(existsSync(file)).toBe(true);
    const [w, h] = webpSize(readFileSync(file));
    expect(w).toBe(width);
    // Same aspect as the PNG fallback, so the <img> width/height still reserve the box.
    const [pw, ph] = pngSize(readFileSync(file.replace(/-\d+\.webp$/, ".png")));
    expect(Math.abs(h - (ph * w) / pw)).toBeLessThanOrEqual(1);
  });

  it("marks every dark source for theme.js, ahead of the light ones", () => {
    const dark = sources.filter((s) => attr(s, "srcset").includes("-dark"));
    expect(dark.length).toBeGreaterThan(0);
    for (const s of dark) {
      expect(attr(s, "data-theme-source")).toBe("dark");
      expect(attr(s, "media")).toBe("(prefers-color-scheme: dark)");
    }
    const lastDark = Math.max(...dark.map((s) => sources.indexOf(s)));
    const firstLight = sources.findIndex((s) => attr(s, "srcset").includes("-light"));
    expect(lastDark).toBeLessThan(firstLight);
  });

  it("keeps the PNG as the <img> fallback, sized to the PNG", () => {
    const img = picture.match(/<img\b[^>]*>/)[0];
    expect(attr(img, "src")).toBe("/assets/screens/models-light.png");
    const [pw, ph] = pngSize(readFileSync(resolve(PUBLIC, "assets/screens/models-light.png")));
    expect([Number(attr(img, "width")), Number(attr(img, "height"))]).toEqual([pw, ph]);
  });
});
