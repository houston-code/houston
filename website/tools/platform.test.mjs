import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// platform.js is a plain browser script (no build step); it also exports via CommonJS so
// the recommendation logic can be tested here.
const require = createRequire(import.meta.url);
const { classify } = require("../public/assets/platform.js");

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const IPAD_UA = MAC_UA; // iPadOS Safari asks for the desktop site by default.
const mac = (extra) => ({ ua: MAC_CHROME_UA, platform: "MacIntel", ...extra });

describe("classify: Macs", () => {
  it("uses Client Hints when Chromium provides them", () => {
    expect(classify(mac({ uaArch: "arm" }))).toEqual({ os: "mac", card: "mac-arm" });
    expect(classify(mac({ uaArch: "x86" }))).toEqual({ os: "mac", card: "mac-x64" });
  });

  it("falls back to the WebGL GPU name", () => {
    expect(classify(mac({ ua: MAC_UA, gpu: "Apple M2 Pro" })).card).toBe("mac-arm");
    expect(classify(mac({ ua: MAC_UA, gpu: "Intel(R) Iris(TM) Plus Graphics 655" })).card).toBe("mac-x64");
    expect(classify(mac({ ua: MAC_UA, gpu: "AMD Radeon Pro 5500M OpenGL Engine" })).card).toBe("mac-x64");
  });

  it("recommends no Mac card when it can't tell (Safari's generic GPU name)", () => {
    // The old behavior recommended Apple Silicon to every Mac, including Intel ones that
    // can't open that build.
    expect(classify(mac({ ua: MAC_UA, gpu: "Apple GPU" }))).toEqual({ os: "mac", card: null, hint: "mac-arch-hint" });
    expect(classify(mac({ ua: MAC_UA }))).toEqual({ os: "mac", card: null, hint: "mac-arch-hint" });
  });

  it("prefers Client Hints over the GPU name", () => {
    expect(classify(mac({ uaArch: "x86", gpu: "Apple M1" })).card).toBe("mac-x64");
  });

  it("treats an iPad asking for the desktop site as no platform", () => {
    expect(classify({ ua: IPAD_UA, platform: "MacIntel", touchPoints: 5 })).toEqual({ os: null, card: null });
    expect(classify({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone" })).toEqual({ os: null, card: null });
  });
});

describe("classify: other platforms", () => {
  it("recommends the Windows installer", () => {
    expect(classify({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" })).toEqual({ os: "win", card: "win" });
  });

  it("recommends the Linux build", () => {
    expect(classify({ ua: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" })).toEqual({ os: "linux", card: "linux" });
  });

  it("offers Linux on Arm the CLI note instead of the x64 build", () => {
    const arm = { os: "linux", card: null, hint: "linux-arm-hint" };
    // Firefox tells the truth in navigator.platform.
    expect(classify({ ua: "Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0", platform: "Linux aarch64" })).toEqual(arm);
    // Chromium's frozen UA says x86_64; Client Hints say arm.
    expect(classify({ ua: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64", uaArch: "arm" })).toEqual(arm);
    expect(classify({ ua: "Mozilla/5.0 (X11; Linux armv7l)", platform: "Linux armv7l" })).toEqual(arm);
  });

  it("recommends nothing for Android or unknown platforms", () => {
    expect(classify({ ua: "Mozilla/5.0 (Linux; Android 15)", platform: "Linux armv8l" })).toEqual({ os: null, card: null });
    expect(classify({ ua: "", platform: "" })).toEqual({ os: null, card: null });
  });
});

describe("landing page wiring", () => {
  const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"), "utf8");

  it("has a card for every recommendation classify can make", () => {
    for (const card of ["mac-arm", "mac-x64", "win", "linux"]) {
      expect(html).toContain(`data-os="${card}"`);
    }
  });

  it("loads platform.js before app.js and ships a hidden Mac hint", () => {
    expect(html.indexOf("/assets/platform.js")).toBeGreaterThan(-1);
    expect(html.indexOf("/assets/platform.js")).toBeLessThan(html.indexOf("/assets/app.js"));
    expect(html).toMatch(/id="mac-arch-hint" hidden/);
    expect(html).toMatch(/id="linux-arm-hint" hidden/);
  });
});

describe("third-party logos", () => {
  const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"), "utf8");

  it("does not draw the Apple logo (Apple's trademark guidelines don't allow it)", () => {
    // The start of the Apple logo's SVG path, as the download cards used to draw it.
    expect(html).not.toContain("M12.152 6.896");
  });
});
