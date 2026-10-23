import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

// Runs assets/theme.js against the real landing page, with the OS scheme and the stored
// choice stubbed, to check that a pinned theme carries the screenshot and the browser
// toolbar color (theme-color) with it.

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const html = readFileSync(resolve(PUBLIC, "index.html"), "utf8");
const themeJs = readFileSync(resolve(PUBLIC, "assets", "theme.js"), "utf8");

async function run({ osDark = false, stored = null } = {}) {
  const dom = new JSDOM(html, { url: "https://houstoncode.ai/", runScripts: "outside-only" });
  const { window } = dom;
  window.matchMedia = () => ({ matches: osDark, addEventListener() {} });
  if (stored) window.localStorage.setItem("houston-theme", stored);
  window.eval(themeJs);
  await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r));
  return window;
}

const media = (doc, scheme) =>
  doc.querySelector(`meta[name="theme-color"][content="${scheme === "dark" ? "#0e1116" : "#ffffff"}"]`).getAttribute("media");
const darkSources = (doc) =>
  [...doc.querySelectorAll('source[data-theme-source="dark"]')].map((s) => s.getAttribute("media"));

describe("theme.js", () => {
  it("leaves the toolbar color and screenshot to the OS when no theme is pinned", async () => {
    const { document: doc } = await run();
    expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(media(doc, "light")).toBe("(prefers-color-scheme: light)");
    expect(media(doc, "dark")).toBe("(prefers-color-scheme: dark)");
    expect(new Set(darkSources(doc))).toEqual(new Set(["(prefers-color-scheme: dark)"]));
  });

  it("applies a stored dark choice to the toolbar color and screenshot on a light OS", async () => {
    const { document: doc } = await run({ stored: "dark" });
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(media(doc, "dark")).toBe("all");
    expect(media(doc, "light")).toBe("not all");
    expect(new Set(darkSources(doc))).toEqual(new Set(["all"]));
    expect(doc.getElementById("theme-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("switches both with the toggle and remembers the choice", async () => {
    const window = await run({ osDark: true });
    const doc = window.document;
    doc.getElementById("theme-toggle").click();
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("houston-theme")).toBe("light");
    expect(media(doc, "light")).toBe("all");
    expect(media(doc, "dark")).toBe("not all");
    expect(new Set(darkSources(doc))).toEqual(new Set(["not all"]));

    doc.getElementById("theme-toggle").click();
    expect(media(doc, "dark")).toBe("all");
    expect(media(doc, "light")).toBe("not all");
  });
});
