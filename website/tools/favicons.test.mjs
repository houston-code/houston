import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { packIco, readIco } from "./ico.mjs";

// Guards the browser-tab icon setup: every page carries the same icon links (pages
// had drifted, some offering only the 1024 px app icon), and each file is what its
// link claims. Any new icon file must also be listed in NOTICE (brand-carve-out.test).

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");
const read = (p) => readFileSync(resolve(PUBLIC, p));

const ICON_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(buf) {
  expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("favicons", () => {
  it("favicon.ico holds 16, 32 and 48 px PNG frames of matching size", () => {
    const frames = readIco(read("favicon.ico"));
    expect(frames.map((f) => [f.width, f.height])).toEqual([[16, 16], [32, 32], [48, 48]]);
    for (const f of frames) expect(pngSize(f.png)).toEqual([f.width, f.height]);
  });

  it("apple-touch-icon.png is 180 px", () => {
    expect(pngSize(read("apple-touch-icon.png"))).toEqual([180, 180]);
  });

  const PAGES = readdirSync(PUBLIC, { recursive: true }).filter((p) => p.endsWith(".html"));

  it("finds the site's pages", () => {
    expect(PAGES).toEqual(expect.arrayContaining(["index.html", "404.html", "privacy.html"]));
  });

  it.each(PAGES)("%s carries the full icon link set", (page) => {
    const html = read(page).toString("utf8");
    for (const link of ICON_LINKS) expect(html).toContain(link);
    // No other icon links (e.g. the 1024 px app icon) for browsers to prefer instead.
    const iconLinks = html.match(/<link rel="(?:icon|apple-touch-icon)"[^>]*>/g);
    expect(iconLinks).toEqual(ICON_LINKS);
  });

  it("the legal-page template emits the same icon links", () => {
    const tpl = readFileSync(resolve(__dirname, "build-legal.mjs"), "utf8");
    for (const link of ICON_LINKS) expect(tpl).toContain(link);
  });
});

describe("packIco", () => {
  it("round-trips frames, encoding 256 px as 0", () => {
    const frames = [
      { size: 16, png: Buffer.from("a") },
      { size: 256, png: Buffer.from("bcd") },
    ];
    const ico = packIco(frames);
    expect(ico.readUInt8(6 + 16)).toBe(0);
    expect(readIco(ico)).toEqual([
      { width: 16, height: 16, png: Buffer.from("a") },
      { width: 256, height: 256, png: Buffer.from("bcd") },
    ]);
  });

  it("rejects out-of-range sizes", () => {
    expect(() => packIco([{ size: 0, png: Buffer.alloc(1) }])).toThrow();
    expect(() => packIco([{ size: 257, png: Buffer.alloc(1) }])).toThrow();
  });
});
