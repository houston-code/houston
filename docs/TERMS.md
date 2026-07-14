<!--
  MAINTAINER NOTE — replace the bracketed placeholders before distributing:
    [Licensor]                  → the legal name of the copyright holder / licensor
    [Governing-law jurisdiction] → the country/state whose law governs
    [Dispute venue]             → courts that have jurisdiction over disputes
  Have a lawyer review this before relying on it. This is a template, not legal advice.
-->

# Houston Terms of Use

**Last updated: July 14, 2026 · Version 1.1**

These Terms of Use ("Terms") are a binding agreement between you ("you" or
"your") and [Licensor] ("we", "us", or "our") and govern your access to and use
of the Houston desktop application and any related documentation and updates
(together, "Houston" or the "Software"). The [LICENSE](../LICENSE) and the
[Privacy Policy](PRIVACY.md) are part of these Terms.

**By installing or using Houston, you agree to these Terms. If you do not agree,
do not install or use Houston.**

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

Your right to use Houston is granted under, and limited by, the
[LICENSE](../LICENSE). Subject to these Terms and the LICENSE, you may install and
use Houston for your personal or internal business purposes. You may not
redistribute, resell, sublicense, modify, or reverse engineer Houston except as
the LICENSE or applicable law expressly allows.

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

Houston, and all intellectual-property rights in it, are owned by us and our
licensors. You retain all rights to your own files, code, prompts, and other
content; we claim no ownership of it. These Terms grant you no rights in our
trademarks or branding.

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

These Terms apply while you use Houston. Your rights end automatically if you
breach them. You may stop using Houston at any time by uninstalling it. Sections
that by their nature should survive termination (including ownership,
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

These Terms, together with the LICENSE and Privacy Policy, are the entire
agreement between you and us regarding Houston and supersede any prior agreement.
If any provision is held unenforceable, the remaining provisions stay in effect.
Our failure to enforce a provision is not a waiver. You may not assign these
Terms without our consent; we may assign them in connection with a merger,
acquisition, or sale of assets.

## 19. Contact

Questions about these Terms: legal@houstoncode.ai.
