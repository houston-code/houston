import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { siteHeader, SITE_FOOTER } from "./site-chrome.mjs";

// The hand-written pages repeat the header and footer that site-chrome.mjs gives the
// generated ones. This keeps every copy identical, so a change to the chrome (the phone
// menu, a new link) can't reach some pages and miss others.

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const read = (p) => readFileSync(resolve(PUBLIC, p), "utf8");
const block = (html, open, close) => {
  const start = html.indexOf(open);
  return start < 0 ? null : html.slice(start, html.indexOf(close, start) + close.length);
};
// The landing page links its own sections in place ("#why"); every other page goes home.
const sameOrigin = (html) => html.replaceAll('href="/#', 'href="#');

const HAND_WRITTEN = ["index.html", "404.html", "contact.html"];
const ALL_PAGES = [
  ...readdirSync(PUBLIC).filter((f) => f.endsWith(".html")),
  ...readdirSync(resolve(PUBLIC, "docs")).filter((f) => f.endsWith(".html")).map((f) => `docs/${f}`),
];

describe("hand-written pages share the site chrome", () => {
  for (const file of HAND_WRITTEN) {
    it(`${file} repeats the header and footer exactly`, () => {
      const html = read(file);
      const header = siteHeader();
      expect(block(html, '<header class="site-header">', "</header>")).toBe(file === "index.html" ? sameOrigin(header) : header);
      expect(block(html, '<footer class="site-footer">', "</footer>")).toBe(SITE_FOOTER);
    });
  }
});

describe("phone menu markup", () => {
  it("finds every page", () => {
    expect(ALL_PAGES.length).toBeGreaterThan(40);
  });

  // One test per page: parsing all of them in one test overran the 5s timeout on slow CI runners.
  for (const file of ALL_PAGES) {
    it(`${file} has the phone menu`, () => {
      const doc = new JSDOM(read(file)).window.document;
      const button = doc.getElementById("nav-menu-button");
      expect(button, file).not.toBeNull();
      // Hidden until app.js wires it up, so a page without JavaScript shows no dead button.
      expect(button.hidden, file).toBe(true);
      expect(button.getAttribute("aria-expanded"), file).toBe("false");
      const menu = doc.getElementById(button.getAttribute("aria-controls"));
      expect(menu?.classList.contains("nav-menu"), file).toBe(true);
      expect([...menu.querySelectorAll(".nav-link")].map((a) => a.textContent), file).toEqual([
        "Security",
        "Features",
        "Docs",
        "FAQ",
        "GitHub",
      ]);
      expect(menu.querySelector("#theme-toggle .theme-toggle-label")?.textContent, file).toBe("Dark theme");
      expect(doc.querySelectorAll("script[src='/assets/app.js']").length, file).toBe(1);
    });
  }
});
