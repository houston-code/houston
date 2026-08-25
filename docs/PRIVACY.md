<!--
  MAINTAINER NOTE — this is a descriptive document, not a contract. It explains
  what Houston does with data so users can decide what to point it at. Keep it in
  sync with the app's actual behavior: if you ever add telemetry, crash
  reporting, or any server-side component, update this file before that ships.
-->

# Privacy

**Last updated: August 25, 2026**

Houston is a locally-installed coding agent. You bring your own model and
credentials, so almost every privacy question comes down to one thing: which
providers you choose to connect. This document explains what Houston stores, what
it sends, and where.

## The short version

- **Houston runs on your device.** Conversations, settings, and project data are
  stored locally on your computer.
- **There is no telemetry.** Houston runs no in-app instrumentation, and the
  project operates no server that receives your content. The only usage signal
  that exists is the aggregate download and update-check count our download host
  keeps for released files, which holds no personal data.
- **Your data leaves your device only to providers you configure.** Prompts,
  code, search queries, and tool calls go to the destinations you set up, under
  those destinations' own privacy policies.

## Stored on your device

Houston writes the following to your operating system's application-data
directory and sends none of it anywhere:

- **Conversations**: your messages, the model's responses, and a record of tool
  activity, saved one file per conversation.
- **Settings**: preferences, configured providers and endpoints, model
  selections, permission rules, and similar configuration.
- **API keys and credentials**: stored in your operating system's secure
  credential storage (for example, the OS keychain) where available, so they are
  encrypted at rest rather than kept in plain configuration files.
- **Window and interface state**: window size, panel layout, and the like.

You can delete any of it by removing the conversation or setting in the app, or
by deleting Houston's application-data directory.

## Sent to providers you configure

Data leaves your device only when you use a feature that reaches the network, and
only to the destination you configured:

- **AI model providers.** When you send a message, the content of your prompt
  (which may include your messages, selected files, code, images, and related
  context) goes to the model provider you configured, using the API key or
  endpoint you supplied. If you run a local model, that data stays on your own
  machine or network.
- **Web search and web fetch.** Search queries and fetched URLs go to the search
  provider or website involved. These actions are gated by Houston's approval
  flow.
- **External tools (Model Context Protocol servers).** Data needed for a tool's
  calls goes to the server you configured.
- **Application updates.** Packaged builds contact the update service to check for
  and download new versions. That involves standard network metadata such as your
  IP address and app version, handled by that service. It does not send your
  conversations or project data. Like any download host, the service keeps
  aggregate counts of how often each released file is fetched; those totals are
  held by that service, contain no personal data, and involve no in-app tracking.

Each of these third parties handles your data under its own policies, which vary
by provider and plan: whether they log it, how long they keep it, and whether
they use it to train or improve their models. Review a provider's policy before
connecting it, and pick providers and settings that suit the sensitivity of your
data. Houston is not an intermediary for that traffic. It flows directly from
your device to the destination you chose, so the provider is the party to ask
about retention, deletion, or access.

## Data residency

Because you choose the providers and their regions, you determine where your data
is processed and stored. If you have data-residency, cross-border-transfer, or
sectoral obligations (GDPR, UK GDPR, CCPA/CPRA, HIPAA, or similar), Houston gives
you the controls to meet them: which provider, which endpoint, which region, and
local versus hosted models. The choices are yours to make.

## Security

Credentials go into your operating system's secure credential storage where
available, and everything else stays on your device. No method of storage or
transmission is completely secure. Keep your operating system, Houston, and your
credentials up to date, and revoke API keys you believe may be compromised. See
[docs/sandboxing.md](sandboxing.md) for how Houston confines what the agent can
reach, and `SECURITY.md` for how to report a vulnerability.

## Questions

Open an issue on the [repository](https://github.com/piyushvijay/houston), or for
anything sensitive, email security@houstoncode.ai.
