<!--
  MAINTAINER NOTE — replace the bracketed placeholders before distributing:
    [Governing-law jurisdiction] → the country/state whose law governs
    [Dispute venue]             → courts that have jurisdiction over disputes
  The contracting party is named inline as the individual who publishes Houston. On
  incorporation, switch it to the company name here and in docs/PRIVACY.md, and keep
  it consistent with SBOM_AUTHOR in scripts/enrich-sbom.mjs.
  Note this is NOT the copyright holder line: Houston's Apache-2.0 LICENSE attributes
  copyright collectively to "The Houston Authors", which is fine for attribution but
  cannot be a contracting party or a data controller.
  Have a lawyer review this before relying on it. This is a template, not legal advice.
-->

# Houston Terms of Use

**Last updated: August 6, 2026 · Version 2.0**

These Terms of Use ("Terms") are a binding agreement between you ("you" or "your")
and Piyush Kumar Vijay ("we", "us", or "our") and govern your access to and use of
the Houston desktop application and any related documentation and updates
(together, "Houston" or the "Software"). The [Privacy Policy](PRIVACY.md) is part
of these Terms.

Houston is open-source software licensed under the Apache License, Version 2.0
(the "[LICENSE](../LICENSE)"). The LICENSE is a separate grant and is **not** part
of these Terms: it governs your rights to use, copy, modify, and redistribute
Houston's source code and binaries, and nothing in these Terms limits, conditions,
or adds to those rights. See section 3.

**By installing or using the Houston application we distribute, you agree to these
Terms. If you do not agree, do not install or use it.**

## 1. What Houston is

Houston is a locally-installed coding-agent application. You bring your own model
and credentials: you connect Houston to AI model providers, web-search providers,
and other services that you choose, using API keys or other credentials that you
supply. Houston can read, write, edit, and delete files in folders you open, run
shell commands on your device, fetch content from the network, and connect to
external tools (including Model Context Protocol servers). Houston acts on your
instructions and within the approval settings you choose.

## 2. Eligibility

You must be at least 18 years old, or the age of majority in your jurisdiction,
and able to form a binding contract, to use Houston. If you use Houston on behalf
of an organization, you represent that you are authorized to bind that
organization to these Terms.

## 3. License

Houston is licensed to you under the Apache License, Version 2.0. The full text is
in the [LICENSE](../LICENSE) file, and a copy ships inside the packaged
application. Among other things, that license lets you use Houston for any
purpose, study and modify its source, and redistribute original or modified
copies, subject to its conditions (keep the license and copyright notices, pass
along the [NOTICE](../NOTICE) file, and mark the files you change).

**The LICENSE controls.** If anything in these Terms conflicts with the LICENSE as
applied to your rights in Houston's source code or binaries, the LICENSE prevails
and the conflicting provision does not apply to those rights. These Terms exist to
set expectations about the copy of Houston **we** distribute (how it behaves, what
you are responsible for, and what we do not warrant), not to claw back anything
the LICENSE grants.

Two things the LICENSE does not cover, which these Terms address: our trademarks
and branding (Apache-2.0 section 6 grants no trademark rights, and neither do
these Terms), and the third-party services and models you connect Houston to,
which are governed by their own terms (see section 8).

## 4. Your responsibilities

You are solely responsible for how you use Houston and for everything that
happens under your use, including:

- **Reviewing and approving actions.** Houston can edit files and run commands.
  You are responsible for reviewing each proposed action and choosing an approval
  mode (for example, plan, ask-every-time, auto-approve, or full-auto). If you
  enable autonomous modes, you accept the consequences of actions taken without
  per-action review.
- **Backups and version control.** You are responsible for backing up your data
  and using version control. Houston may modify or delete files; **keep recoverable
  copies of anything you cannot afford to lose.**
- **What you run it against.** You are responsible for the projects, files,
  repositories, and systems you point Houston at, and for having the right to do
  so.
- **Credentials and costs.** You are responsible for your own API keys and other
  credentials, for keeping them secure, and for all usage fees, rate limits, and
  charges that the providers you connect bill to those credentials. We charge
  nothing for and have no control over third-party provider billing.
- **Compliance.** You are responsible for using Houston in compliance with all
  laws and with the terms of every third-party service you connect.

## 5. Acceptable use

You agree not to use Houston to:

- violate any law or regulation, or infringe anyone's rights;
- access, test, or attack any system, network, or data without authorization;
- develop or distribute malware, or carry out fraud or other harmful activity;
- generate or distribute unlawful content; or
- violate export-control or sanctions laws, or use Houston where prohibited.

You are responsible for ensuring your use, and your transfer of data to the
providers you select, complies with applicable export, sanctions, and trade laws.

## 6. AI output: no reliance

Houston relies on third-party AI models that you select. AI output may be
inaccurate, incomplete, insecure, biased, or otherwise wrong, and may not be
suitable for your purposes. **You must independently review and verify all output
before relying on it, especially before running generated commands or shipping
generated code.** Houston does not provide professional advice of any kind. You
are responsible for the results of acting on Houston's output.

## 7. Code execution and security

Houston reads, writes, executes, and deletes files and runs shell commands on
your device, and can access the network. Where the operating system supports it,
Houston confines shell commands to a sandbox; **sandboxing is per-platform,
best-effort, and imperfect, and on some platforms shell commands run without OS
confinement.** See [docs/sandboxing.md](sandboxing.md) for the current
per-platform model. You acknowledge these limitations and accept the risk of
running an agent that can execute code on your device. Do not run Houston, or
approve actions, against untrusted code, repositories, or instructions unless you
understand and accept the risk.

## 8. Third-party services, models, and content

Houston is "bring your own model" and connects only to the providers and services
you configure, including AI model providers, web-search providers, Model Context
Protocol servers, and content the agent fetches from the web.

- **Their terms govern.** Your use of any third-party service or model is subject
  to that provider's own terms of service, acceptable-use policy, and privacy
  policy. Review them before connecting.
- **Their data and training practices govern.** The data you send to a provider
  (including your prompts, code, files, and other inputs) is handled under that
  provider's policies, **including whether the provider logs, retains, or uses
  that data to train or improve its models.** Practices vary by provider and plan.
  It is your responsibility to choose providers and settings consistent with your
  confidentiality and data-handling obligations.
- **We are not responsible.** We do not control, endorse, or assume responsibility
  for any third-party service, model, or content, or for any data you transmit to
  them. Third-party components bundled with Houston are governed by their own
  open-source licenses.

## 9. Privacy and data residency

How Houston handles data is described in the [Privacy Policy](PRIVACY.md). In
short, Houston stores your data locally on your device and does not collect
analytics or telemetry from the app; data leaves your device only to the providers and
services you choose to use. **You, not we, determine where your data goes when
you select a provider, and you are solely responsible for meeting any
data-residency, data-protection, sectoral, or cross-border transfer obligations
that apply to you** (for example, GDPR, UK GDPR, CCPA/CPRA, HIPAA, or similar).
Choose providers, regions, and configurations accordingly.

## 10. Updates

Houston may check for and install updates, including to address security issues.
Updates are subject to these Terms. We may change, suspend, or discontinue
Houston or any feature at any time.

## 11. Intellectual property

Copyright in Houston is held by us, our contributors, and our licensors. Making
Houston available under the Apache License 2.0 does not transfer that ownership;
it grants you the broad rights described in section 3, and those rights are yours
to exercise without further permission from us.

You retain all rights to your own files, code, prompts, and other content; we
claim no ownership of it, and Houston sends none of it to us.

The "Houston" name, logo, and branding are **not** licensed to you. Apache-2.0
section 6 expressly withholds trademark rights, and these Terms grant none either.
You may state truthfully that your work is based on or derived from Houston; you
may not use our name or marks in a way that suggests we publish, endorse, or
support your distribution.

## 12. Disclaimer of warranties

TO THE MAXIMUM EXTENT PERMITTED BY LAW, HOUSTON IS PROVIDED "AS IS" AND "AS
AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, EXPRESS, IMPLIED, OR STATUTORY,
INCLUDING WITHOUT LIMITATION IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, TITLE, ACCURACY, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT
HOUSTON WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE, THAT DEFECTS WILL BE
CORRECTED, OR THAT OUTPUT WILL BE ACCURATE OR RELIABLE. SECURITY ARTIFACTS
PUBLISHED WITH RELEASES (INCLUDING SOFTWARE BILLS OF MATERIALS, VEX DOCUMENTS,
AND SECURITY ADVISORIES) ARE GOOD-FAITH ASSESSMENTS AS OF THEIR STATED
TIMESTAMP, ARE PROVIDED FOR INFORMATION ONLY, ARE NOT A WARRANTY OR GUARANTEE OF
SECURITY, AND MAY BE REVISED WITHOUT NOTICE. YOU USE HOUSTON AT YOUR OWN RISK.

## 13. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL WE OR OUR CONTRIBUTORS
BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR
PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, OR FOR
DELETED, CORRUPTED, OR LOST FILES OR CODE, OR FOR DAMAGE ARISING FROM COMMANDS
HOUSTON EXECUTES OR FROM YOUR USE OF THIRD-PARTY SERVICES, ARISING OUT OF OR
RELATED TO HOUSTON OR THESE TERMS, WHETHER IN CONTRACT, TORT (INCLUDING
NEGLIGENCE), OR OTHERWISE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO HOUSTON WILL NOT
EXCEED THE GREATER OF THE AMOUNT YOU PAID US FOR HOUSTON OR US $0.

Some jurisdictions do not allow the exclusion or limitation of certain damages,
so some of the above may not apply to you. In that case our liability is limited
to the maximum extent permitted by law.

## 14. Indemnification

To the maximum extent permitted by law, you will indemnify, defend, and hold
harmless us and our contributors from and against any claims, liabilities,
damages, losses, and expenses (including reasonable legal fees) arising out of or
related to: (a) your use of Houston; (b) your content, files, or credentials;
(c) your use of any third-party service or model; or (d) your violation of these
Terms or of any law or third-party right.

## 15. Termination

These Terms apply while you use Houston. Your rights **under these Terms** end
automatically if you breach them. This does not terminate your Apache-2.0 license,
which ends only on its own terms (see LICENSE section 4 and the patent-litigation
clause in section 3). You may stop using Houston at any time by uninstalling it.
Sections that by their nature should survive termination (including ownership,
disclaimers, limitation of liability, indemnification, and governing law) survive.

## 16. Changes to these Terms

We may update these Terms from time to time. When we do, we will revise the
"Last updated" date and version above and may surface the updated Terms in the
application. Your continued use of Houston after an update takes effect means you
accept the updated Terms.

## 17. Governing law and disputes

These Terms are governed by the laws of [Governing-law jurisdiction], without
regard to conflict-of-laws rules. You agree to the exclusive jurisdiction of the
courts located in [Dispute venue] for any dispute arising out of or relating to
Houston or these Terms, except where applicable law gives you the right to bring
a claim elsewhere.

## 18. Miscellaneous

These Terms, together with the Privacy Policy, are the entire agreement between
you and us regarding the copy of Houston we distribute, and supersede any prior
agreement. The LICENSE stands on its own alongside them and, as section 3 says,
prevails over these Terms wherever the two conflict.
If any provision is held unenforceable, the remaining provisions stay in effect.
Our failure to enforce a provision is not a waiver. You may not assign these
Terms without our consent; we may assign them in connection with a merger,
acquisition, or sale of assets.

## 19. Contact

Questions about these Terms: legal@houstoncode.ai.
