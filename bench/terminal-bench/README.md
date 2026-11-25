# Terminal-Bench kit

Runs [Terminal-Bench](https://www.tbench.ai) 4.1 tasks against Houston through the
[Harbor](https://github.com/harbor-framework/harbor) framework's ACP agent, with a spend cap
on every job. Harbor starts each task's container, installs Node and its ACP client there,
launches Houston with `npx` from an ACP registry entry (`agent.json`), sends the task's
instruction as one ACP prompt, and grades the result with the task's verifier.

Nothing here runs in CI except the unit tests for the helpers. Every real run is billed by
the model provider, so it starts only from your shell, with your key, under a cap you set.

| File | What it is |
| --- | --- |
| `run.sh` | Runs a job through Harbor and stops it at the spend cap. |
| `spend.mjs` | The spend guard: sums the cost Houston reports for a job's trials. Also prints the results table. |
| `agent.json` | The ACP registry entry template: the published CLI with `--acp --unattended --full-auto --effort high --max-turns 400`. |
| `agent-entry.mjs` | Writes the entry for one run: as written, pinned to a release, or pointed at a local build. |
| `tasks.txt` | The 8 tasks the 2026-11 pilot ran, used when you name none. |
| `RESULTS.md` | Per-trial results of the pilot runs. |

## Prerequisites

- **Docker**, with the daemon running and room for the task images (several GB each).
  The images are linux/amd64; on an Apple Silicon Mac they run under emulation, which is
  how the pilot ran.
- **Node 22.19 or newer** on the host, for the kit's helpers.
- **Harbor 0.26.0**, with the ACP client pinned to `agent-client-protocol` 0.9.0 (below).
- **A provider key in the environment**: `ANTHROPIC_API_KEY` for `anthropic/` models,
  `OPENAI_API_KEY` for `openai/`, `GEMINI_API_KEY` for `gemini/`. `run.sh` reads it from the
  environment only: it never reads a key file, prints the key, or writes it anywhere.
- **A Houston build that has `--unattended`** (below).

### Harbor, with the agent-client-protocol 0.9.0 pin

Harbor 0.26.0 installs the newest `agent-client-protocol` Python package into every task
container to run its ACP client. Newer releases of that package no longer export
`text_block`, which the client imports, so every trial fails before Houston starts:

```text
ImportError: cannot import name 'text_block' from 'acp'
```

Install Harbor from a checkout with that install pinned to 0.9.0. The pilot ran commit
`ec6aeab7` (version 0.26.0) with this one-line change:

```bash
git clone https://github.com/harbor-framework/harbor.git && cd harbor
git checkout ec6aeab7
sed -i.orig 's/--python {runner_python} agent-client-protocol$/--python {runner_python} "agent-client-protocol==0.9.0"/' \
  src/harbor/agents/installed/acp.py
grep -n 'agent-client-protocol==0.9.0' src/harbor/agents/installed/acp.py   # must print one line
uv tool install .    # or pip install . in a virtualenv
```

### A Houston build that has `--unattended`

`agent.json` launches `@houston-code/cli@latest`, and the newest release, 0.12.0, predates
the ACP launch flags this kit depends on: its `--acp` ignores everything after it, so a run
would get none of `--unattended`, `--full-auto`, `--effort` or `--max-turns`. Until a release
carries them, build the CLI package from a checkout of `main` (Node 22.19+ and `npm ci` first):

```bash
npm run build:cli                    # out/cli/houston-cli.cjs, the self-contained CLI
node scripts/stage-npm-cli.mjs       # out/npm-cli/, the @houston-code/cli package
mkdir -p ~/.cache/houston-bench/dist
npm pack ./out/npm-cli --pack-destination ~/.cache/houston-bench/dist
```

That writes `houston-code-cli-<version>.tgz`, named for the version in `package.json`. Pass
it to `run.sh` with `--pkg`, and name the commit with `--label` so every trial records which
build it ran. Once a release has the flags, use `--release <version>` instead.

## Running a job

```bash
cd /path/to/houston
pkg=~/.cache/houston-bench/dist/houston-code-cli-0.12.0.tgz

# Free plumbing check: a placeholder key, so Houston's first model call is refused.
bench/terminal-bench/run.sh --dry-run --pkg "$pkg" dry-1 anthropic/claude-haiku-5-5 fin-saccr-rwa

# The 8 tasks in tasks.txt, two at a time, stopped once Houston reports $35 spent.
bench/terminal-bench/run.sh --cap 35 --pkg "$pkg" --label "main.$(git rev-parse --short HEAD)" \
  opus-1 anthropic/claude-opus-5-5
```

A dry run exercises everything but the model: the image pull, Harbor's setup, the package
mount, the launch, and the ACP handshake. Its trial ends with `NonZeroAgentExitCodeError`, and
`agent/acp-summary.json` in the trial folder shows the provider's 401 and your build's
version. Run one after any change to Harbor, Docker, or the build.

`run.sh` prints the Harbor command before it starts it. For the second job above it is:

```bash
harbor run -d terminal-bench/terminal-bench@4.1.0 \
  --include-task-name terminal-bench/glycan-ms2-elucidation \
  --include-task-name terminal-bench/medical-claims-processing \
  --include-task-name terminal-bench/ontology-kg-querying \
  --include-task-name terminal-bench/sound-change-cascade \
  --include-task-name terminal-bench/sglang-qwen-burst \
  --include-task-name terminal-bench/vpp-loss-divergence \
  --include-task-name terminal-bench/ks-solver-cpp \
  --include-task-name terminal-bench/fin-saccr-rwa \
  --agent acp --ak registry_entry_path=$HOME/.cache/houston-bench/jobs/opus-1.agent.json \
  -m anthropic/claude-opus-5-5 --ae 'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}' -y \
  --env docker \
  --mounts '[{"type":"bind","source":"<path to the .tgz>","target":"/opt/houston-pkg/houston-code-cli-0.12.0.tgz","read_only":true}]' \
  -n 2 --job-name opus-1 -o $HOME/.cache/houston-bench/jobs
```

The key goes in as the literal `${ANTHROPIC_API_KEY}` reference: Harbor records that in the
job's config and resolves it from your environment when it starts each container. The entry
`run.sh` writes for a local build mounts the tarball read-only (the file alone, not the
folder it is in) and launches its `houston` command through npx:

```json
"npx": {
  "package": "--package=/opt/houston-pkg/houston-code-cli-0.12.0.tgz",
  "args": ["houston", "--acp", "--unattended", "--full-auto", "--effort", "high", "--max-turns", "400"]
}
```

Other options: `-n <count>` trials at once (default 2), `--jobs-dir <dir>`, and task names
after the model to run a subset. The pilot's 8-task jobs took 1.5 to 2 hours at `-n 2`.

## The spend guard

Every 60 seconds (`BENCH_POLL_SECONDS`), `run.sh` runs `spend.mjs` on the job. It sums the
cost Houston itself reports for each trial: the running total in Houston's ACP
`usage_update`, priced from Houston's model table (`src/shared/model-facts.ts`). A trial
still running counts from the updates Harbor's client appends to its
`agent/acp-events.jsonl` as they arrive, a finished one from `agent/acp-summary.json`. It is
the same number Harbor records as each trial's `cost_usd`.

Once the total reaches `--cap`, `run.sh` stops the job: it sends Harbor SIGTERM (Harbor then
cancels the running trials), kills Harbor if it is still running after 120 seconds
(`BENCH_STOP_GRACE`), removes any container left from this job's trials (and no other), and
exits 3. Ctrl-C, or closing the terminal, stops the job the same way. The guard also fails
closed: if the spend check itself fails three polls in a row (a trial file it cannot read
counts as a failure, never as zero spend, and so does a trial that has run a tool or used
tokens but reported no cost), it stops the job rather than run on without a limit. The latest table is in `<job>.spend` next to the job, and you can check a job at any
time:

```bash
node bench/terminal-bench/spend.mjs ~/.cache/houston-bench/jobs/opus-1
```

What it does not cover:

- **It can overshoot** by what the running trials spend between two polls and while they
  wind down. In the pilot an Opus trial spent up to about $0.40 a minute, so at `-n 2` allow a
  dollar or two above the cap.
- **Delegated work counts only once it finishes.** Houston reports a subagent's or a review's
  cost over ACP in one update when that work ends, so the cap can be overshot by a whole
  dispatch, and one cut off when the job is stopped may never be counted, here or in Harbor's
  `cost_usd`.
- **A model Houston can't price can't be run under the cap.** Houston reports a cost of 0
  for a model missing from its price table, and no `usage_update` at all for one whose
  context window it doesn't know, so the guard can't see what such a trial spends. It
  treats a trial that has done work without reporting a cost as a failed check, which
  stops the job within three polls, after a few minutes of uncounted spend. Pick a model
  in `src/shared/model-facts.ts`.
- **It is Houston's estimate**, not the provider's bill, and it reads log files written
  inside the task container. Check the provider's usage page after a large run.
- **There is no per-trial money limit.** `--max-turns 400` caps the steps of each trial, but
  ACP has no `--max-cost` yet (headless `-p` runs do), so the job cap is the only limit on
  spend.

## Keeping results

Jobs go to `~/.cache/houston-bench/jobs` unless you pass `--jobs-dir`: outside any checkout,
so they can't be committed by accident or deleted along with a worktree. Each trial folder
holds the full trajectory and the task's own content. Never commit job folders, raw Harbor
logs, or leaderboard exports to this repository, and treat publishing results anywhere as a
separate decision. What belongs here is the summary table:

```bash
node bench/terminal-bench/spend.mjs ~/.cache/houston-bench/jobs/opus-1 --markdown
```

Add it to [RESULTS.md](RESULTS.md) with the job's setup: dataset, Harbor version, build,
model, and concurrency. `harbor view <jobs-dir>` browses the trajectories locally.

Harbor can also launch an agent by name from the ACP registry instead of from a file. That
needs Houston's entry submitted to the registry first.
