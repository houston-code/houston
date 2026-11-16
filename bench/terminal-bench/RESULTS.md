# Terminal-Bench results

Per-trial results of runs made with this kit, newest first. Each table is the output of
`node bench/terminal-bench/spend.mjs <job-dir> --markdown`. The job folders themselves
(trajectories, logs) are not kept in this repository.

## 2026-11 pilot

**Opus 5.5 solved 3 of 8 tasks. Haiku 5.5 solved 0 of 8, on both builds it ran.**

| Job | Model | Build | Solved | Exceptions | Cost (Houston-reported) | Wall time |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| pilot-opus | claude-opus-5-5 | B | 3/8 | 0 | $27.59 | 1h 28m |
| pilot-haiku-v2 | claude-haiku-5-5 | B | 0/8 | 0 | $3.40 | 1h 49m |
| pilot-haiku | claude-haiku-5-5 | A | 0/8 | 2 | $2.00 | 1h 33m |

Setup, the same for every job:

- **Dataset:** `terminal-bench/terminal-bench@4.1.0` (ref
  `sha256:5881c1b1c74a96f07baef00a7c869e09802704bc0dc912c870e7acccc11440da`), the 8 tasks in
  `tasks.txt`, one attempt each, Harbor's default timeouts.
- **Harness:** Harbor 0.26.0 (commit `ec6aeab7`) with the `agent-client-protocol` 0.9.0 pin,
  Docker on an Apple Silicon Mac, 2 trials at a time.
- **Build A,** `0.12.0+main.e5a26f14`: `main` at `e5a26f14`, launched with
  `--acp --full-auto --effort high --max-turns 400`.
- **Build B,** `0.12.0+main.f49a4a7b+pr879+pr880`: `main` at `f49a4a7b` plus #879 (ACP frames
  kept under 64 KiB) and #880 (`--unattended`, which sends back a turn that stops on undone
  work), both merged to `main` since. Launched with the same flags plus `--unattended`.

Houston reported $32.99 for the three jobs. The guard used during the pilot estimated $42.64,
because it priced every Haiku request at the rate for prompts over 100K tokens (Houston prices
each request by its own length) and took the higher of its estimate and Houston's figure. For
Opus the two agreed. `spend.mjs` now uses Houston's figure alone.

### pilot-opus

| Task | Model | Houston build | Reward | Input tokens | Cached input | Output tokens | Cost | Agent time | Ended |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| fin-saccr-rwa | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 1 | 1,237,062 | 1,150,969 | 59,765 | $1.85 | 10 min | end_turn |
| glycan-ms2-elucidation | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 185,474 | 151,096 | 24,919 | $0.70 | 5 min | end_turn |
| ks-solver-cpp | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 9,088,908 | 8,912,175 | 128,338 | $5.23 | 29 min | end_turn |
| medical-claims-processing | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 4,108,618 | 3,763,041 | 62,457 | $3.73 | 12 min | end_turn |
| ontology-kg-querying | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 6,974,426 | 6,271,962 | 88,750 | $6.54 | 16 min | end_turn |
| sglang-qwen-burst | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 4,583,195 | 4,301,960 | 67,808 | $3.62 | 32 min | end_turn |
| sound-change-cascade | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 1 | 1,575,865 | 1,476,142 | 61,947 | $2.03 | 12 min | end_turn |
| vpp-loss-divergence | claude-opus-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 1 | 6,521,981 | 6,252,228 | 63,760 | $3.87 | 18 min | end_turn |
| **Total** | | | **3/8** | 34,275,529 | 32,279,573 | 557,744 | **$27.59** | | |

### pilot-haiku-v2

| Task | Model | Houston build | Reward | Input tokens | Cached input | Output tokens | Cost | Agent time | Ended |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| fin-saccr-rwa | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 1,321,514 | 1,016,476 | 223,684 | $0.23 | 17 min | end_turn |
| glycan-ms2-elucidation | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 314,978 | 271,632 | 33,585 | $0.02 | 3 min | end_turn |
| ks-solver-cpp | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 1,473,972 | 1,383,972 | 72,547 | $0.06 | 14 min | end_turn |
| medical-claims-processing | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 8,939,305 | 4,529,962 | 627,156 | $2.06 | 53 min | end_turn |
| ontology-kg-querying | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 2,157,310 | 1,279,645 | 250,709 | $0.59 | 19 min | end_turn |
| sglang-qwen-burst | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 3,451,145 | 3,242,287 | 98,042 | $0.11 | 33 min | end_turn |
| sound-change-cascade | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 3,593,888 | 3,227,778 | 133,886 | $0.14 | 33 min | end_turn |
| vpp-loss-divergence | claude-haiku-5-5 | 0.12.0+main.f49a4a7b+pr879+pr880 | 0 | 6,240,393 | 5,751,757 | 135,142 | $0.19 | 21 min | end_turn |
| **Total** | | | **0/8** | 27,492,505 | 20,703,509 | 1,574,751 | **$3.40** | | |

### pilot-haiku

| Task | Model | Houston build | Reward | Input tokens | Cached input | Output tokens | Cost | Agent time | Ended |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| fin-saccr-rwa | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | 2,359,194 | 1,425,964 | 407,928 | $0.61 | 30 min | end_turn |
| glycan-ms2-elucidation | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | 912,658 | 821,583 | 64,124 | $0.05 | 7 min | end_turn |
| ks-solver-cpp | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | 41,234 | 27,201 | 49,089 | $0.03 | 4 min | end_turn |
| medical-claims-processing | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | - | - | - | $0.16 | 13 min | NonZeroAgentExitCodeError |
| ontology-kg-querying | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | 5,190,590 | 3,832,643 | 229,835 | $0.62 | 18 min | end_turn |
| sglang-qwen-burst | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | - | - | - | $0.16 | 31 min | NonZeroAgentExitCodeError |
| sound-change-cascade | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | 4,809,151 | 4,350,874 | 206,684 | $0.20 | 27 min | end_turn |
| vpp-loss-divergence | claude-haiku-5-5 | 0.12.0+main.e5a26f14 | 0 | 5,606,860 | 5,233,806 | 131,560 | $0.16 | 17 min | end_turn |
| **Total** | | | **0/8** | 18,919,687 | 15,692,071 | 1,089,220 | **$2.00** | | |

### What the pilot found

- **Two build A trials lost their connection.** Harbor's ACP client reads Houston's output
  one line at a time with a 64 KiB limit, and on medical-claims-processing (reading PNG
  invoices) and sglang-qwen-burst (an edit to a large source file) one frame went over it.
  The client dropped the connection, the trial ended with `NonZeroAgentExitCodeError`, and no
  token counts were recorded (their cost is Houston's last update before the drop). #879
  keeps every frame under the limit, and no build B trial failed this way.
- **Three build A trials stopped before doing the work.** With no one to answer, Haiku ended
  its only turn announcing what it would do next (ks-solver-cpp, which never wrote its
  solver, and fin-saccr-rwa, which never wrote its output) or handing a choice back to the
  user (vpp-loss-divergence). #880 added `--unattended`, which sends such a turn back to keep
  working. On build B no Haiku trial ended on an announced next step (ks-solver-cpp wrote its
  solver this time), though some (fin-saccr-rwa and ontology-kg-querying among them) still
  ended by leaving a decision to the user, which the early-stop check does not catch yet.
- **Haiku 5.5 scored 0 on both builds.** The fixes changed how its trials ended, not what
  they scored. The 3 Opus solves cost $1.85 to $3.87 each, and no trial in any job hit the
  400-step cap.

### Before the pilot

One smoke trial (`html-js-filter`, Haiku 5.5, build A) scored 0 for $0.17. Five dry runs on
the same task worked through the setup: the first failed on the `text_block` import error
that the `agent-client-protocol` pin fixes, and the last reached Houston and ended on the
placeholder key's 401, as a dry run should.
