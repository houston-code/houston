# Houston CLI

Houston is a coding agent you run in your terminal. Bring your own model: Claude, GPT, Gemini, any OpenAI-compatible endpoint, or a local model.

This package is the standalone CLI, a single self-contained file with no desktop app, no Chromium and no display server. It needs Node 22 or newer.

```bash
npm install -g @houston-code/cli
houston --help
```

It also installs with other npm-compatible tools, for example `bun add -g @houston-code/cli`.

## Usage

```bash
ANTHROPIC_API_KEY=sk-... houston -p "Summarize the architecture" --cwd ~/code/myproj
ANTHROPIC_API_KEY=sk-... houston -i
```

`houston -p` runs one task and prints the answer; `houston -i` (or bare `houston`) starts an interactive session.

## Links

- Website: https://houstoncode.ai
- Source, issues and the desktop app: https://github.com/houston-code/houston
- Security reports: security@houstoncode.ai

Licensed under Apache-2.0.
