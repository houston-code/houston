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
statement to the `statements` array and bump the top-level `version`. Example:

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

`not_affected` / `fixed` suppress the finding in the gate; `affected` /
`under_investigation` document it without suppressing (so it still blocks until resolved).

Keep the assessment honest: a `not_affected` claim is a security statement you are signing.
