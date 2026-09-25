# VEX (Vulnerability Exploitability eXchange)

[`houston.openvex.json`](houston.openvex.json) is an [OpenVEX](https://github.com/openvex)
document that records, per CVE, whether a vulnerability found in Houston's production
dependency closure actually affects Houston. It answers the question a raw scanner cannot:
"the scanner flagged CVE-X in dependency Y, but does it actually put users at risk here?"

## How it is used

Every `grype` scan (the lockfile gate in [`sbom.yml`](../workflows/sbom.yml) and the `scan`
job of [`release-publish.yml`](../workflows/release-publish.yml), and the native-layer scans in
[`native-vuln-scan.yml`](../workflows/native-vuln-scan.yml) and the release's Linux leg) reads
this file via `--vex`. Any statement with status `not_affected` or `fixed` moves the matching
finding out of the active set, so no gate fails on a vulnerability you have consciously
assessed and accepted.

What happens to the rest depends on the layer; see [Release policy](#release-policy) below.

Each release publishes its own copy of this document: the statements here, plus generated
`affected` statements for the native-layer findings the release ships with. That copy is
attached to the GitHub Release and cosign-signed alongside the SBOMs, so downstream consumers
get your risk assessment, not just the dependency list.

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

## Release policy

**npm dependency closure (the lockfile gate): every fixable High/Critical blocks.** An npm fix
is always one `npm update` (or override) away, so there is no reason to ship without it.

**Native layer (Electron, and the Chromium and Node it embeds; node-pty; rg; ast-grep): a
fixable High/Critical blocks only when the fix is shippable today.**
[`scripts/native-vuln-policy.mjs`](../../scripts/native-vuln-policy.mjs) classifies each one:

- **Blocking.** A *stable* Electron release already bundles a Chromium, Node or Electron at or
  above the fixed version, so Houston is simply behind: bump Electron. Also any finding in a
  component Electron does not supply (node-pty, rg, ast-grep), since that fix is ours to take.
- **Tracked, not blocking.** Only a pre-release Electron (alpha, beta, nightly) has the fix.
  Each Electron major stays on its Chromium major, and a Chromium security batch usually lands
  weeks before a stable Electron carries it. Blocking for that window would stop every other
  fix from shipping, including the ones Electron has already backported, and make nobody
  safer. Pre-release runtimes are never shipped to clear a scanner.

Tracked findings are not hidden. They are recorded in two places:

1. **GitHub code scanning** (the repository's Security tab, category `native-runtime`).
   [`native-vuln-scan.yml`](../workflows/native-vuln-scan.yml) uploads them daily and before
   every release; an alert closes itself once a scan stops reporting it.
2. **The release's VEX document**, as an `affected` statement with an action statement naming
   the fixed version. These are generated per release, not written here, so there is nothing
   to clean up when Electron catches up.

The scan summary (on the workflow run) also marks any tracked finding on CISA's Known
Exploited Vulnerabilities list, so it is taken the moment a stable Electron carries the fix.

**When a gate fires**, the pre-build `native-scan` job of the release fails within a minute,
before anything is built, with the Electron version that fixes it; the daily scan files an
issue. The release's post-build scan applies the same policy to the packaged binaries and adds
node-pty, rg and ast-grep. Metadata that cannot be fetched fails closed.

Keep writing statements here only for a real assessment (`not_affected` with a justification,
or `fixed` for a backport you can tie to the CVE). A hand-written statement for a CVE and
product takes precedence over the generated one.
