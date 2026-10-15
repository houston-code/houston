# Security policy

Houston is a desktop coding agent that can read, edit, and execute code on your
machine, and can send code and prompts to whichever model provider you configure.
Security reports are taken seriously — thank you for helping keep users safe.

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue,
pull request, or discussion for a suspected vulnerability.

- Use GitHub's private vulnerability reporting: open the repository's **Security**
  tab and choose **Report a vulnerability**
  (<https://github.com/houston-code/houston/security/advisories/new>). This creates a
  private advisory visible only to the maintainers and you.
- If you can't use GitHub's flow — or prefer email — write to
  **security@houstoncode.ai**, which is monitored privately by the maintainers.

Please include, as far as you can:

- the affected version (see **Houston → About**, or the title-bar version) and your
  operating system;
- a description of the issue and its security impact;
- clear steps to reproduce, ideally with a minimal proof of concept;
- any relevant logs, screenshots, or crash output.

Please do not include live secrets (API keys, tokens) in a report — redact them.

## What to expect

- **Acknowledgement** within 3 business days that the report was received.
- **An initial assessment** (severity and whether we can reproduce it) within
  10 business days.
- **Progress updates** as we work on a fix, and coordination with you on a
  disclosure timeline.

We ask that you give us a reasonable opportunity to release a fix before any public
disclosure, and that testing never involves other people's data, denial-of-service,
or physical or social-engineering attacks.

## Supported versions

Houston ships as a rolling release and updates in place. Security fixes land in the
**latest released version**; there are no long-term support branches. If you are
running an older build, update before reporting so the issue can be confirmed against
current code.

| Version         | Supported          |
| --------------- | ------------------ |
| Latest release  | :white_check_mark: |
| Older releases  | :x:                |

## Scope and security model

Houston's security model (the shell sandbox per platform, workspace path containment
for file tools, the approval flow for writes / commands / network egress, and
encrypted-at-rest key storage) is described in the
[Security model](README.md#security-model) section of the README and in
[docs/sandboxing.md](docs/sandboxing.md). Reports that account for that model are
especially helpful.

The following are **expected behavior**, not vulnerabilities, because they follow
directly from the tool's purpose and are gated by explicit user consent:

- The agent executing model-authored shell commands or file edits **after you approve
  them**, or under a more autonomous approval policy (*auto-edit* / *full auto*) that
  you deliberately selected. Running a coding agent in *full auto* with network access
  is equivalent to running untrusted code, as the README notes.
- A configured model provider, web-search provider, or Model Context Protocol server
  receiving the data you direct the agent to send it. Those services are governed by
  their own terms, not by Houston.

Even so, *full auto* is defended in depth rather than treated as a blank cheque, because
the sandbox can read your whole filesystem: network egress is granted **per destination**
(not all-or-nothing), the first shell command takes a **one-time network consent** so
blanket outbound access is never automatic (a decline runs commands offline), and
Houston's own network tools (`web_fetch` / `web_search`) **refuse to send** a URL or query
that carries a recognized credential. Granted shell network is additionally confined to a
**per-domain egress allowlist** on macOS and Linux: the OS sandbox blocks direct sockets
and routes shell egress through a Houston-controlled loopback proxy, which allows only
package registries, VCS hosts, and domains you add in Settings (see
[docs/sandboxing.md](docs/sandboxing.md)). These bound the exfiltration surface; they do
not eliminate it. Egress bodies over TLS are not inspected (the proxy sees hostnames, not
content), an allowlisted collaborative host still accepts authenticated writes, and on
Windows (no OS sandbox) the allowlist cannot be enforced.

Text that outsiders write and Houston's tools pull into the agent's context (fetched web
pages, web search results, GitHub issue and pull request titles, bodies, comments, and
diffs, and MCP tool results and resources) is treated as **data, not instructions**. It
arrives inside a fence tagged with a **fresh random nonce per call**, so the text cannot
close the fence and pose as Houston's own framing, and only fields the platform
guarantees (such as an issue's number, state, author, and URL) render outside it. A web
page or MCP result that scores as a prompt-injection attempt is read by an **isolated
model call with no tools and no history**, and only that call's report reaches the agent;
if the isolated read fails, the content is withheld. GitHub text and search results that
score as an attempt stay inline with a warning, because the agent needs their exact text.
The scoring is a heuristic that can be worded around, so this is defense in depth behind
the approval flow, not a guarantee that a model never acts on injected text.

Reports that demonstrate a way to **bypass** a control that is supposed to hold (for
example, escaping the shell sandbox, writing outside the workspace without approval,
reaching a private/metadata network address through a network tool, sending network
egress to a destination the run was never granted, exfiltrating a stored key through one
of Houston's own network tools, getting outsider-written tool output to close its
untrusted-content fence or render outside it, or leaking stored keys to the renderer or
disk in plaintext) are in scope and very welcome.
