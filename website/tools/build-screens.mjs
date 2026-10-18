// Encodes the landing-page screenshots (assets/screens/models-{dark,light}.png, 1600 px
// wide) as WebP at each width in WIDTHS, so the hero <picture> can offer a srcset and a
// phone no longer downloads the full desktop PNG. The PNGs stay as the <img> fallback.
// Uses the Chromium that Playwright already vendors for this repo's e2e tests.
// Re-run after the screenshots change:  node website/tools/build-screens.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENS = resolve(__dirname, "..", "public", "assets", "screens");

export const SHOTS = ["models-dark", "models-light"];
export const WIDTHS = [800, 1200, 1600];
// High enough that small UI text stays crisp; lower settings blur the model names.
const QUALITY = 0.9;

// Only encode when run directly, so the test can import the lists above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  for (const shot of SHOTS) {
    const src = "data:image/png;base64," + readFileSync(resolve(SCREENS, `${shot}.png`)).toString("base64");
    for (const width of WIDTHS) {
      const b64 = await page.evaluate(
        async ({ src, width, quality }) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = Math.round((img.height * width) / img.width);
          const ctx = canvas.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/webp", quality).split(",")[1];
        },
        { src, width, quality: QUALITY }
      );
      const out = `${shot}-${width}.webp`;
      const buf = Buffer.from(b64, "base64");
      writeFileSync(resolve(SCREENS, out), buf);
      console.log(`✓ website/public/assets/screens/${out} (${Math.round(buf.length / 1024)} KB)`);
    }
  }
  await browser.close();
}
