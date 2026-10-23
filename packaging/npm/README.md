# Houston CLI

Houston is an AI coding agent you run in your terminal. Bring your own model: Claude, GPT, Gemini, any OpenAI-compatible endpoint, or a local model.

This package is the standalone CLI, a single self-contained file with no desktop app, no Chromium and no display server. It needs Node 22 or newer. If you prefer a desktop app, download it from [houstoncode.ai](https://houstoncode.ai).

```bash
npm install -g @houston-code/cli
houston --help
```

It also installs with other npm-compatible tools, for example `bun add -g @houston-code/cli`.

## Usage

Start an interactive session in your project folder:

```bash
houston -i
```

Plain `houston` does the same when run in a terminal. On first run, type `/login` to pick a model provider and add its API key.

Run a single task and print the answer, for scripts and CI:

```bash
houston -p "Summarize the architecture" --cwd ~/code/myproj
```

## Model providers

Houston reads keys from the standard environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`), or you can store one with `houston providers set-key <provider>`. Run `houston providers` to list configured providers and add others, such as OpenRouter, Groq or a custom OpenAI-compatible endpoint.

Keys set with `/login` or `houston providers set-key` are used by both `houston -i` and `houston -p`. An environment variable, if set, takes precedence.

## Links

- Website and desktop app: https://houstoncode.ai
- Source and issues: https://github.com/houston-code/houston
- Security reports: security@houstoncode.ai

Licensed under Apache-2.0.
