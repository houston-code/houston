import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { load } from "js-yaml";
import { Arch, getArtifactArchName } from "builder-util/out/arch.js";

// Guards against drift: the download buttons on the landing page find their release
// asset by filename suffix (assets/app.js matches `data-asset-suffix` against the
// latest release's asset names). electron-builder does NOT expand `${arch}` to the
// same string for every format: x64 is `x86_64` in an AppImage name and `amd64` in a
// .deb name. A suffix that no build produces silently leaves that button pointing at
// the generic releases page, so derive every real filename from electron-builder.yml
// with electron-builder's own arch mapping and check each suffix against them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const config = load(readFileSync(resolve(ROOT, "electron-builder.yml"), "utf8"));
const html = readFileSync(resolve(ROOT, "website", "public", "index.html"), "utf8");

// The human-facing installers the site links to, as [artifactName owner, ext, arch].
const BUILDS = [
  ["dmg", "dmg", Arch.arm64],
  ["dmg", "dmg", Arch.x64],
  ["nsis", "exe", Arch.x64],
  ["appImage", "AppImage", Arch.x64],
  ["deb", "deb", Arch.x64],
];

function artifactName(section, ext, arch) {
  const pattern = config[section]?.artifactName;
  if (!pattern) throw new Error(`electron-builder.yml has no ${section}.artifactName`);
  return pattern
    .replace("${productName}", config.productName)
    .replace("${version}", "1.2.3")
    .replace("${arch}", getArtifactArchName(arch, ext))
    .replace("${ext}", ext);
}

const produced = BUILDS.map(([section, ext, arch]) => artifactName(section, ext, arch));
const suffixes = [...html.matchAll(/data-asset-suffix="([^"]+)"/g)].map((m) => m[1]);

describe("landing-page download links match the release asset names", () => {
  it("links every installer electron-builder produces", () => {
    expect(suffixes).toHaveLength(BUILDS.length);
  });

  for (const suffix of suffixes) {
    it(`${suffix} resolves to exactly one built artifact`, () => {
      expect(produced.filter((name) => name.endsWith(suffix))).toHaveLength(1);
    });
  }
});
