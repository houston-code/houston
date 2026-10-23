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

describe("release feed", () => {
  // Every page loads app.js; only the landing page has anything to fill from the feed.
  async function fetches(file) {
    const page = readFileSync(resolve(PUBLIC, file), "utf8");
    const dom = new JSDOM(page, { url: "https://houstoncode.ai/", runScripts: "outside-only" });
    const calls = [];
    dom.window.fetch = (url) => (calls.push(url), Promise.reject(new Error("offline")));
    dom.window.eval(appJs);
    await new Promise((r) => setTimeout(r, 20));
    return calls;
  }

  it("is read once on the landing page", async () => {
    expect(await fetches("index.html")).toEqual(["https://api.github.com/repos/houston-code/houston/releases/latest"]);
  });

  it("is not read on pages without download links", async () => {
    for (const file of ["contact.html", "404.html", "privacy.html", "docs/index.html", "docs/models.html"]) {
      expect(await fetches(file), file).toEqual([]);
    }
  });
});

describe("phone menu", () => {
  async function page() {
    const dom = new JSDOM(html, { url: "https://houstoncode.ai/", runScripts: "outside-only" });
    const { window } = dom;
    window.HoustonPlatform = { classify: () => ({ os: null, card: null }) };
    window.fetch = () => Promise.reject(new Error("offline"));
    window.eval(appJs);
    await new Promise((r) => setTimeout(r, 20));
    const doc = window.document;
    const button = doc.getElementById("nav-menu-button");
    const menu = doc.getElementById("nav-menu");
    const open = () => button.getAttribute("aria-expanded") === "true" && menu.classList.contains("is-open");
    const closed = () => button.getAttribute("aria-expanded") === "false" && !menu.classList.contains("is-open");
    return { window, doc, button, menu, open, closed };
  }

  it("reveals the button and opens and closes the panel with it", async () => {
    const { button, open, closed } = await page();
    expect(button.hidden).toBe(false);
    expect(closed()).toBe(true);
    button.click();
    expect(open()).toBe(true);
    button.click();
    expect(closed()).toBe(true);
  });

  it("closes when a link in it is followed, but not on the theme switch", async () => {
    const { doc, button, menu, open, closed } = await page();
    button.click();
    doc.getElementById("theme-toggle").click();
    expect(open()).toBe(true);
    menu.querySelector('a[href="#faq"]').click();
    expect(closed()).toBe(true);
  });

  it("closes on a click elsewhere on the page", async () => {
    const { doc, button, closed } = await page();
    button.click();
    doc.querySelector("main").click();
    expect(closed()).toBe(true);
  });

  it("closes on Escape and gives focus back to the button", async () => {
    const { window, doc, button, menu, closed } = await page();
    button.click();
    menu.querySelector("a").focus();
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed()).toBe(true);
    expect(doc.activeElement).toBe(button);
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

describe("CLI install copy buttons", () => {
  async function page(clipboard) {
    const dom = new JSDOM(html, { url: "https://houstoncode.ai/", runScripts: "outside-only" });
    const { window } = dom;
    window.HoustonPlatform = { classify: () => ({ os: "mac", card: "mac-arm" }) };
    window.fetch = () => Promise.reject(new Error("offline"));
    window.HTMLCanvasElement.prototype.getContext = () => null;
    if (clipboard) Object.defineProperty(window.navigator, "clipboard", { value: clipboard, configurable: true });
    window.eval(appJs);
    await new Promise((r) => setTimeout(r, 20));
    return window.document;
  }

  it("lists every install channel, in order", () => {
    const doc = new JSDOM(html).window.document;
    expect([...doc.querySelectorAll(".cli-cmds code")].map((c) => c.textContent)).toEqual([
      "brew install houston-code/tap/houston",
      "npm install -g @houston-code/cli",
      "bun add -g @houston-code/cli",
      "curl -fsSL https://houstoncode.ai/install.sh | sh",
    ]);
  });

  it("ships one hidden button per command", () => {
    const doc = new JSDOM(html).window.document;
    const rows = [...doc.querySelectorAll(".cli-cmds dd")];
    expect(rows).toHaveLength(4);
    for (const dd of rows) {
      const btn = dd.querySelector(".copy-btn");
      expect(btn.hidden).toBe(true);
      expect(btn.getAttribute("type")).toBe("button");
      expect(btn.getAttribute("aria-label")).toMatch(/^Copy the .+ command$/);
    }
  });

  it("stays hidden where the clipboard API is missing", async () => {
    const doc = await page(null);
    expect([...doc.querySelectorAll(".copy-btn")].every((b) => b.hidden)).toBe(true);
  });

  it("copies exactly the command on its row and confirms it", async () => {
    const written = [];
    const doc = await page({ writeText: (t) => (written.push(t), Promise.resolve()) });
    const buttons = [...doc.querySelectorAll(".copy-btn")];
    expect(buttons.every((b) => !b.hidden)).toBe(true);
    buttons[3].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual(["curl -fsSL https://houstoncode.ai/install.sh | sh"]);
    expect(buttons[3].textContent).toBe("Copied");
    expect(doc.getElementById("copy-status").textContent).toBe("Command copied.");
  });

  it("selects the command for Cmd/Ctrl+C when every copy route is refused", async () => {
    const doc = await page({ writeText: () => Promise.reject(new Error("denied")) });
    doc.execCommand = () => false;
    const btn = doc.querySelector(".copy-btn");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.textContent).toBe("Selected");
    expect(doc.defaultView.getSelection().toString()).toBe("brew install houston-code/tap/houston");
    expect(doc.getElementById("copy-status").textContent).toMatch(/Press Ctrl\+C or Cmd\+C/);
  });

  it("falls back to the older copy command when the clipboard API is refused", async () => {
    const doc = await page({ writeText: () => Promise.reject(new Error("denied")) });
    doc.execCommand = (cmd) => cmd === "copy";
    const btn = doc.querySelector(".copy-btn");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.textContent).toBe("Copied");
  });
});
