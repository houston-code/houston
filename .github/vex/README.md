# VEX (Vulnerability Exploitability eXchange)

[`houston.openvex.json`](houston.openvex.json) is an [OpenVEX](https://github.com/openvex)
document that records, per CVE, whether a vulnerability found in Houston's production
dependency closure actually affects Houston. It answers the question a raw scanner cannot:
"the scanner flagged CVE-X in dependency Y, but does it actually put users at risk here?"

## How it is used

The vulnerability scan gate (`grype` in [`sbom.yml`](../workflows/sbom.yml) and the `scan`
job of [`release-publish.yml`](../workflows/release-publish.yml)) reads this file via
`--vex`. Any statement with status `not_affected` or `fixed` moves the matching finding out
of the active set, so the gate does not fail on a vulnerability you have consciously
assessed and accepted. Everything else still blocks a release.

The document is also attached to each GitHub Release and cosign-signed alongside the SBOMs,
so downstream consumers get your risk assessment, not just the dependency list.

## Disclaimer

SBOMs, VEX documents, and security advisories published with releases are good-faith
assessments as of their stated timestamp, provided for information only. They are not a
warranty or guarantee of security and may be revised without notice. The binding disclaimer
is sections 7 and 8 of the Apache-2.0 `LICENSE`, which Houston ships under.

## Adding a statement (the triage)

When the scan gate flags a High/Critical you are not going to fix immediately, add a
statement to the `statements` array, bump the top-level `version`, and set the top-level
`last_updated` to the edit date. Example:

```json
{
  "vulnerability": { "name": "CVE-2025-12345" },
  "products": [{ "@id": "pkg:npm/some-dep@1.2.3" }],
  "status": "not_affected",
  "justification": "vulnerable_code_not_in_execute_path",
  "impact_statement": "Houston never calls the affected parser entry point.",
  "timestamp": "2026-08-01T00:00:00Z"
}
```

- **`status`**: `not_affected` | `affected` | `fixed` | `under_investigation`.
- **`justification`** (required for `not_affected`): one of `component_not_present`,
  `vulnerable_code_not_present`, `vulnerable_code_not_in_execute_path`,
  `vulnerable_code_cannot_be_controlled_by_adversary`, `inline_mitigations_already_exist`.
- **`impact_statement`**: a human-readable reason, recommended for `not_affected`.
- **Notes must be self-contained.** The document is attached to public releases and read
  far from this repo, so `status_notes` / `impact_statement` must carry the full rationale
  on their own. Never reference repo-internal paths (this README included) or anything
  else a downstream consumer cannot access; link only public URLs, if anything.

`not_affected` / `fixed` suppress the finding in the gate; `affected` /
`under_investigation` document it without suppressing (so it still blocks until resolved).

Keep the assessment honest: a `not_affected` claim is a security statement you are signing.

## Known security hold: bundled Chromium (Electron 44.4.x)

As of 2026-09-25 the binary SBOM vuln gate flags **122 fixable High/Critical CVEs**
(44 Critical, 78 High) in the Chromium **152.0.7977.130** that Electron 44.4.3 through 44.4.5
embed. All are fixed upstream in the Chromium 153 branch (153.0.8010.36, .47 and .52). They
are recorded here with status `under_investigation`, which documents the assessment
**without** suppressing the gate, so a release stays blocked until the runtime is upgraded.

**Why they are not suppressed.** These are Chromium renderer bugs, reachable in principle by
any app that renders web content. There is no honest `not_affected` justification for them.
Electron does cherry-pick upstream security fixes into 44.x (44.4.5 carries 35 of them), but
Chromium keeps the underlying bugs restricted, so none of the backports can be mapped to a
CVE id, and a `fixed` claim would be a guess.

**Why the runtime is not bumped yet.** Each Electron major stays on its Chromium major, so the
44 line will keep reporting Chromium 152 however many fixes it backports. The only published
builds with Chromium 153 or later are **45.0.0 pre-releases** (Chromium 155), which are not
shipped to production. So the release is held rather than shipping either a known-vulnerable
or a pre-release runtime.

**How this clears.** When Electron 45.0.0 goes stable (expect newer Chromium CVEs by then, so
re-scan against a fresh grype DB rather than trusting this list):

1. bump the `electron` devDependency in `package.json` to that release, and check for
   breaking changes in the Electron 45 release notes;
2. `npm run rebuild:native` to rebuild node-pty against the new Electron ABI;
3. `npm run dist:unpacked`, then regenerate the binary SBOM and confirm
   `grype sbom:... --only-fixed` reports no fixable High/Critical;
4. run `npm run test:e2e`;
5. **delete these `under_investigation` statements** and this section, bump the top-level
   `version`, and update `last_updated`.
