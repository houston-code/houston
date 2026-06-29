<!--
  MAINTAINER NOTE — replace the bracketed placeholders before distributing:
    [Licensor]      → the legal name of the data controller / publisher
    [Contact email] → a real contact address for privacy requests
  Keep this in sync with the app's actual data behavior. If you ever add
  telemetry, crash reporting, or any server-side component, this document MUST be
  updated before that ships. Have a lawyer review before relying on it.
-->

# Houston — Privacy Policy

**Last updated: June 29, 2026 · Version 1.0**

This Privacy Policy explains how Houston (the "Software"), published by [Licensor]
("we", "us", "our"), handles your information. It is part of the
[Terms of Use](TERMS.md).

## Summary

- **Houston runs on your device.** Your conversations, settings, and project data
  are stored locally on your computer.
- **We collect no analytics or telemetry.** Houston does not send your usage,
  conversations, code, or personal data to us. We operate no server that receives
  your content.
- **Your data leaves your device only to providers you choose.** When you use a
  feature that reaches the network — sending a prompt to an AI model, searching
  the web, connecting an external tool, or checking for app updates — data goes to
  that destination, under that destination's own privacy policy, not ours.
- **You control where your data goes.** Because Houston is "bring your own model",
  you decide which providers and regions handle your data, and you are responsible
  for meeting your own data-residency and data-protection obligations.

## 1. Information stored on your device

Houston stores the following locally, in your operating system's application-data
directory, and does not transmit it to us:

- **Conversations** — your messages, the model's responses, and a record of tool
  activity, saved one file per conversation.
- **Settings** — your preferences, configured providers and endpoints, model
  selections, permission rules, and similar configuration.
- **API keys and credentials** — stored using your operating system's secure
  credential storage (for example, the OS keychain) where available, so they are
  encrypted at rest rather than kept in plain configuration files.
- **Window and interface state** — for example, window size and panel layout.

You can delete this data at any time by deleting the relevant conversations or
settings within the app, or by removing Houston's application-data directory and
uninstalling the Software.

## 2. Information sent to third parties you choose

Houston is designed so that data leaves your device only when you use a feature
that requires it, and only to the destination you have configured. Specifically:

- **AI model providers.** When you send a message, the content of your prompt —
  which may include your messages, selected files, code, images, and related
  context — is sent to the AI model provider you have configured (using the API
  key or endpoint you supplied) so it can generate a response. This includes
  local models you run yourself, in which case the data stays on your own machine
  or network.
- **Web search and web fetch.** If you use web search or let the agent fetch a
  URL, the relevant query or request is sent to the search provider or website
  involved. These actions are gated by Houston's approval flow.
- **External tools (Model Context Protocol servers).** If you connect an external
  tool, data needed for that tool's calls is sent to the server you configured.
- **Application updates.** Packaged builds may contact the update service to check
  for and download new versions. This involves standard network metadata (such as
  your IP address and app version) handled by that service; it does not send your
  conversations or project data.

**These third parties operate under their own privacy policies and terms, not
ours.** Their handling of your data — including whether they log it, how long
they retain it, and whether they use it to train or improve their models —
is governed by them, and varies by provider and plan. Review each provider's
policy before connecting, and choose providers and settings appropriate for the
sensitivity of your data.

## 3. We are not a processor of your provider data

We do not receive, store, or process the data you send to the third-party
providers you configure. We are not an intermediary for that traffic; it flows
directly from your device to the destination you chose. As a result, for that
data, the provider — not us — is the relevant party for any data-subject request,
retention question, or compliance matter.

## 4. Data residency and your compliance obligations

Because you choose your providers and their regions, **you determine where your
data is processed and stored, and you are solely responsible for meeting any
data-residency, cross-border-transfer, data-protection, or sectoral requirements
that apply to you** — for example, the GDPR, UK GDPR, CCPA/CPRA, HIPAA, or
similar laws. Houston gives you the controls (which provider, which endpoint,
which region, local vs. hosted models); the choices, and their legal
consequences, are yours.

## 5. Children

Houston is not directed to children and is intended for users who meet the
eligibility requirements in the [Terms of Use](TERMS.md). We do not knowingly
collect personal information from children.

## 6. Security

Houston stores credentials using your operating system's secure credential
storage where available and keeps your other data on your device. No method of
storage or transmission is completely secure, and the security of data you send
to third-party providers, and of your device itself, is your responsibility. Keep
your operating system, Houston, and your credentials secure, and revoke API keys
you believe may be compromised.

## 7. Your rights

Because your Houston data lives on your device and under the third-party providers
you choose, you exercise most data rights directly: you can view, export, or
delete conversations and settings within the app or your filesystem, and you
should direct requests about data held by a provider (access, deletion,
retention) to that provider. If you have questions about this Policy, contact us
at [Contact email].

## 8. Changes to this Policy

We may update this Policy from time to time. When we do, we will revise the "Last
updated" date and version above and may surface the updated Policy in the
application. If we ever introduce analytics, telemetry, crash reporting, or any
server-side component, we will update this Policy before that change ships.

## 9. Contact

Questions or privacy requests: [Contact email].
