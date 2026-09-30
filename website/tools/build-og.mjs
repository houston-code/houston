// Rasterizes assets/og.svg → assets/og.png (1200×630) for social-card previews.
// Uses the Chromium that Playwright already vendors for this repo's e2e tests.
// Re-run after editing og.svg:  node website/tools/build-og.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "..", "public", "assets");

// Composite the real app icon and the dark product screenshot, so the card matches
// the site exactly.
const dataUri = (file) =>
  "data:image/png;base64," + readFileSync(resolve(ASSETS, file)).toString("base64");
const svg = readFileSync(resolve(ASSETS, "og.svg"), "utf8")
  .replace("{{ICON_DATA_URI}}", dataUri("icon.png"))
  .replace("{{SHOT_DATA_URI}}", dataUri("screens/models-dark.png"));

// CHROMIUM_PATH points at a specific Chromium when Playwright's own download for this
// version isn't installed.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
  { waitUntil: "networkidle" }
);
const el = await page.$("svg");
await el.screenshot({ path: resolve(ASSETS, "og.png") });
await browser.close();
console.log("✓ website/public/assets/og.png (1200×630)");
