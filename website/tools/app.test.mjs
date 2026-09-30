import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

// Runs assets/app.js against the real landing page, with platform detection and the
// GitHub release feed stubbed, to check where the hero download button ends up.

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const html = readFileSync(resolve(PUBLIC, "index.html"), "utf8");
const appJs = readFileSync(resolve(PUBLIC, "assets", "app.js"), "utf8");

const ARM_DMG = "https://github.com/houston-code/houston/releases/download/v1.2.3/Houston-1.2.3-arm64.dmg";
const RELEASE = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/houston-code/houston/releases/tag/v1.2.3",
  assets: [
    { name: "Houston-1.2.3-arm64.dmg", browser_download_url: ARM_DMG },
    { name: "Houston-1.2.3-x64.dmg", browser_download_url: "https://github.com/houston-code/houston/releases/download/v1.2.3/Houston-1.2.3-x64.dmg" },
  ],
};

async function run({ platform, release }) {
  const dom = new JSDOM(html, { url: "https://houstoncode.ai/", runScripts: "outside-only" });
  const { window } = dom;
  window.HoustonPlatform = { classify: () => platform };
  window.fetch = () =>
    release instanceof Error
      ? Promise.reject(release)
      : Promise.resolve({ ok: true, json: () => Promise.resolve(release) });
  // jsdom has no canvas; app.js already treats a missing WebGL context as "no hint".
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.eval(appJs);
  await new Promise((r) => setTimeout(r, 20));
  const doc = window.document;
  return {
    hero: doc.getElementById("hero-download").getAttribute("href"),
    label: doc.getElementById("hero-download-label").textContent,
    version: doc.getElementById("hero-version"),
    primaryCards: [...doc.querySelectorAll(".dl-card")]
      .filter((c) => c.querySelector(".dl-primary").classList.contains("btn-primary"))
      .map((c) => c.getAttribute("data-os")),
  };
}

describe("hero download button", () => {
  it("downloads the recommended build directly once its file is known", async () => {
    const r = await run({ platform: { os: "mac", card: "mac-arm" }, release: RELEASE });
    expect(r.hero).toBe(ARM_DMG);
    expect(r.label).toBe("Download for macOS");
    expect(r.version.hidden).toBe(false);
    expect(r.version.textContent).toBe("v1.2.3 release notes");
    expect(r.version.getAttribute("href")).toBe(RELEASE.html_url);
  });

  it("scrolls to the cards when the release feed is unreachable", async () => {
    const r = await run({ platform: { os: "mac", card: "mac-arm" }, release: new Error("offline") });
    expect(r.hero).toBe("#download");
    expect(r.version.hidden).toBe(true);
  });

  it("scrolls to the cards when no single build fits the visitor", async () => {
    const r = await run({ platform: { os: "mac", hint: "mac-arch-hint" }, release: RELEASE });
    expect(r.hero).toBe("#download");
    expect(r.label).toBe("Download for macOS");
  });

  it("never points the button at a non-https asset URL", async () => {
    const bad = { ...RELEASE, assets: [{ name: "Houston-1.2.3-arm64.dmg", browser_download_url: "javascript:alert(1)" }] };
    const r = await run({ platform: { os: "mac", card: "mac-arm" }, release: bad });
    expect(r.hero).toBe("#download");
  });
});

describe("download card buttons", () => {
  it("highlights only the recommended card's button", async () => {
    const r = await run({ platform: { os: "win", card: "win" }, release: RELEASE });
    expect(r.primaryCards).toEqual(["win"]);
  });

  it("keeps all four highlighted when no single build fits", async () => {
    const r = await run({ platform: { os: "mac", hint: "mac-arch-hint" }, release: RELEASE });
    expect(r.primaryCards).toEqual(["mac-arm", "mac-x64", "win", "linux"]);
  });
});
