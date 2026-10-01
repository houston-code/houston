// Renders the browser/tab icons from the app icon (assets/icon.png, 1024×1024):
//   favicon.ico          16, 32 and 48 px frames (PNG-encoded ICO entries)
//   apple-touch-icon.png 180 px, for iOS home screens and Safari favorites
// Uses the Chromium that Playwright already vendors for this repo's e2e tests.
// Re-run after the app icon changes:  node website/tools/build-favicons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { packIco } from "./ico.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");

const iconDataUri =
  "data:image/png;base64," +
  readFileSync(resolve(PUBLIC, "assets", "icon.png")).toString("base64");

const browser = await chromium.launch();
const page = await browser.newPage();

// Downscale by repeated halving (then one final step) so tiny sizes keep a clean
// edge instead of the aliasing a single 1024→16 draw produces.
async function render(size) {
  const b64 = await page.evaluate(
    async ({ src, size }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      let canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      while (canvas.width / 2 >= size) {
        const next = document.createElement("canvas");
        next.width = canvas.width / 2;
        next.height = canvas.height / 2;
        const ctx = next.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(canvas, 0, 0, next.width, next.height);
        canvas = next;
      }
      if (canvas.width !== size) {
        const last = document.createElement("canvas");
        last.width = last.height = size;
        const ctx = last.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(canvas, 0, 0, size, size);
        canvas = last;
      }
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { src: iconDataUri, size }
  );
  return Buffer.from(b64, "base64");
}

const ico = packIco([
  { size: 16, png: await render(16) },
  { size: 32, png: await render(32) },
  { size: 48, png: await render(48) },
]);
writeFileSync(resolve(PUBLIC, "favicon.ico"), ico);
writeFileSync(resolve(PUBLIC, "apple-touch-icon.png"), await render(180));
await browser.close();
console.log("✓ website/public/favicon.ico (16, 32, 48), apple-touch-icon.png");
