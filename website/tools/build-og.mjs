// Rasterizes assets/og.svg → assets/og.png (1200×630) for social-card previews.
// Uses the Chromium that Playwright already vendors for this repo's e2e tests.
// Re-run after editing og.svg:  node website/tools/build-og.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "..", "assets");
const svg = readFileSync(resolve(ASSETS, "og.svg"), "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
  { waitUntil: "networkidle" }
);
const el = await page.$("svg");
await el.screenshot({ path: resolve(ASSETS, "og.png") });
await browser.close();
console.log("✓ website/assets/og.png (1200×630)");
