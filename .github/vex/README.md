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

## Known security hold: bundled Chromium (Electron 43.1.0)

As of 2026-07-12 the binary SBOM vuln gate flags **19 fixable High/Critical CVEs**
(including Critical **CVE-2026-15113**, a use-after-free in Chromium's Autofill) in the
Chromium **150.0.7871.47** that Electron 43.1.0 embeds. All 19 are fixed upstream in
Chromium **150.0.7871.115**. They are recorded here with status `under_investigation`,
which documents the assessment **without** suppressing the gate, so a release stays blocked
until the runtime is upgraded.

**Why they are not suppressed.** These are Chromium renderer memory-safety bugs, reachable
in principle by any app that renders web content. There is no honest `not_affected`
justification for them, so blanket-suppressing them to go green would be dishonest (and is
exactly what this file exists to prevent).

**Why the runtime is not bumped yet.** No stable Electron release bundles a Chromium at or
above 150.0.7871.115. The 43 line tops out at 43.1.0 (Chromium 150.0.7871.47), and the only
published build carrying the fix is a 44.x **alpha** (Chromium 151), which is not shipped to
production. So the release is held rather than shipping either a known-vulnerable or a
pre-release runtime.

**How this clears.** When Electron publishes a **stable** 43.x or 44.x whose bundled Chromium
is at or above 150.0.7871.115:

1. bump the `electron` devDependency in `package.json` to that release;
2. `npm run rebuild:native` to rebuild node-pty against the new Electron ABI;
3. `npm run dist:unpacked`, then regenerate the binary SBOM and confirm
   `grype sbom:... --only-fixed` reports no fixable High/Critical;
4. run `npm run test:e2e`;
5. **delete these `under_investigation` statements**, bump the top-level `version`, and
   update `last_updated`.
