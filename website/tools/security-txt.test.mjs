import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// A security contact nobody can find is the same as none at all, and an expired
// security.txt is invalid per RFC 9116 rather than merely stale. These assertions keep
// the file valid and keep it pointing at channels that are actually monitored.

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const text = readFileSync(resolve(site, ".well-known", "security.txt"), "utf8");
const redirects = readFileSync(resolve(site, "_redirects"), "utf8");

/** Field values by lowercased name; RFC 9116 allows a field to repeat. */
const fields = text
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .reduce((acc, line) => {
    const at = line.indexOf(":");
    if (at < 0) return acc;
    const name = line.slice(0, at).trim().toLowerCase();
    (acc[name] ||= []).push(line.slice(at + 1).trim());
    return acc;
  }, {});

describe("security.txt", () => {
  it("carries the two fields RFC 9116 requires", () => {
    expect(fields.contact?.length).toBeGreaterThan(0);
    expect(fields.expires?.length).toBe(1);
  });

  it("has not expired", () => {
    const expires = new Date(fields.expires[0]);
    expect(Number.isNaN(expires.getTime())).toBe(false);
    // Renew the Expires date in website/public/.well-known/security.txt. Do not delete
    // this check: past its date the file is invalid, not just old.
    expect(expires.getTime()).toBeGreaterThan(Date.now());
  });

  it("expires within two years, so the contact is reviewed periodically", () => {
    const twoYears = Date.now() + 2 * 365 * 24 * 60 * 60 * 1000;
    expect(new Date(fields.expires[0]).getTime()).toBeLessThan(twoYears);
  });

  it("points only at monitored channels", () => {
    // security@houstoncode.ai is a confirmed mailbox and the advisory path is enabled.
    // A contact address that bounces is worse than no file, so the set is pinned.
    expect(fields.contact).toContain("mailto:security@houstoncode.ai");
    for (const contact of fields.contact) {
      expect(contact).toMatch(/^(mailto:security@houstoncode\.ai|https:\/\/github\.com\/houston-code\/houston\/security\/advisories\/new)$/);
    }
  });

  it("names its own canonical URL", () => {
    expect(fields.canonical).toContain("https://houstoncode.ai/.well-known/security.txt");
  });

  it("links the policy, not just an address", () => {
    expect(fields.policy?.[0]).toBe(
      "https://github.com/houston-code/houston/blob/main/SECURITY.md"
    );
  });

  it("uses no em dashes, matching the rest of the site copy", () => {
    expect(text).not.toMatch(/—/);
  });

  it("also answers on the deprecated root path scanners still probe", () => {
    expect(redirects).toMatch(
      /^\/security\.txt\s+\/\.well-known\/security\.txt\s+30[18]\s*$/m
    );
  });
});
