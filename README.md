# Coder Pro

An open-source, local-first **coding agent desktop app for macOS**. Bring your own
model — Claude, GPT, Gemini, any OpenAI-compatible endpoint, or a local LLM
(Ollama / LM Studio) — and let it read, edit, and run code inside a sandboxed
project folder.

> Status: early. Built incrementally — see the git history.

## Features

- Multi-provider model picker: Anthropic (Claude), OpenAI (GPT), Google (Gemini),
  any OpenAI-compatible API, and local models via Ollama / LM Studio.
- Agentic tool use: read / write / edit files, list & search the tree, run shell
  commands — with every action gated by an approval flow.
- macOS **Seatbelt sandbox** (`sandbox-exec`) confines tool execution to the
  chosen workspace.
- API keys stored encrypted in the macOS Keychain via Electron `safeStorage`.

## Develop

```bash
npm install
npm run dev
```

## Build a DMG

```bash
npm run dist
```

The resulting `.dmg` is in `release/`. It is **unsigned** — see
[Installing an unsigned build](#installing-an-unsigned-build).

## Tech

Electron + Vite + React + TypeScript.

## License

[MIT](./LICENSE)
