#!/usr/bin/env bash
# Run Terminal-Bench 4.1 tasks against Houston through Harbor's ACP agent, and stop the job
# once the cost Houston reports for it reaches a cap. README.md covers the setup.
#
# Usage: bench/terminal-bench/run.sh --cap <usd> [options] <job-name> <provider/model> [task...]
#
#   --cap <usd>            stop the job once its trials' reported cost reaches this (required
#                          for a real run)
#   --pkg <file.tgz>       run a local build of the CLI package instead of a published one
#   --label <build>        build label for --pkg, shown as each trial's agent version (default: local)
#   --release <version>    run this published @houston-code/cli version (default: agent.json as written)
#   -n, --concurrency <n>  trials at once (default: 2)
#   --jobs-dir <dir>       where Harbor writes the job (default: ~/.cache/houston-bench/jobs,
#                          outside any checkout, so trajectories are never committed by accident
#                          or deleted with a worktree)
#   --dry-run              check the plumbing for free: the API key is a placeholder, so
#                          Houston's first model call is refused and nothing is billed
#
# Tasks default to tasks.txt. The provider key comes from the environment only
# (ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, by the model's provider). This script
# never prints it or writes it anywhere: Harbor gets the ${VAR} reference, records that, and
# resolves it from this environment when it starts each task container.
#
# Next to the job it writes <job>.agent.json (the entry Harbor launched) and <job>.spend (the
# latest spend table, refreshed every poll). Exits 3 when the guard stopped the job (the cap
# was reached, or three spend checks in a row failed), else with Harbor's status. HARBOR and
# DOCKER name the commands (default: harbor and docker on PATH);
# BENCH_POLL_SECONDS (default 60) sets how often spend is checked, BENCH_STOP_GRACE (default
# 120) how many seconds Harbor gets to wind down after the cap before it is killed.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
dataset='terminal-bench/terminal-bench@4.1.0'
dry_key='houston-bench-dry-run-placeholder'
harbor=${HARBOR:-harbor}
docker=${DOCKER:-docker}
poll=${BENCH_POLL_SECONDS:-60}
grace=${BENCH_STOP_GRACE:-120}
name_re='^[A-Za-z0-9][A-Za-z0-9._-]*$'

die() {
  echo "run.sh: $*" >&2
  exit 2
}
usage() {
  echo 'usage: run.sh --cap <usd> [--pkg <file.tgz> [--label <build>] | --release <version>]' >&2
  echo '              [-n <count>] [--jobs-dir <dir>] [--dry-run] <job-name> <provider/model> [task...]' >&2
  exit 2
}

cap='' pkg='' label='' release='' conc=2 jobs_dir='' dry=0
while [ $# -gt 0 ]; do
  case $1 in
    --cap | --pkg | --label | --release | -n | --concurrency | --jobs-dir)
      [ $# -ge 2 ] || die "$1 needs a value"
      case $1 in
        --cap) cap=$2 ;;
        --pkg) pkg=$2 ;;
        --label) label=$2 ;;
        --release) release=$2 ;;
        -n | --concurrency) conc=$2 ;;
        --jobs-dir) jobs_dir=$2 ;;
      esac
      shift 2
      ;;
    --dry-run)
      dry=1
      shift
      ;;
    -h | --help) usage ;;
    --)
      shift
      break
      ;;
    -*) die "unknown option: $1" ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || usage
job=$1 model=$2
shift 2

[[ $job =~ $name_re ]] || die "job name may hold only letters, digits, dots, hyphens and underscores: $job"
case ${model%%/*} in
  anthropic) key_var=ANTHROPIC_API_KEY ;;
  openai) key_var=OPENAI_API_KEY ;;
  gemini) key_var=GEMINI_API_KEY ;;
  *) die "the model must be provider/model with provider anthropic, openai or gemini: $model" ;;
esac
[ "${model#*/}" != "$model" ] && [ -n "${model#*/}" ] || die "the model must be provider/model: $model"
[[ $conc =~ ^[1-9][0-9]*$ ]] || die "-n needs a whole number of at least 1: $conc"
[[ $grace =~ ^[0-9]+$ ]] || die "BENCH_STOP_GRACE must be whole seconds: $grace"
command -v node >/dev/null 2>&1 || die 'node is required (22 or newer)'
command -v "$harbor" >/dev/null 2>&1 || die "Harbor not found ($harbor); see README.md"

if [ "$dry" -eq 1 ]; then
  # A dry run spends nothing, so any reported cost at all means something is wrong.
  [ -n "$cap" ] || cap=0.01
elif [ -z "$cap" ]; then
  die 'a real run needs --cap <usd>, the most it may spend'
elif [ -z "${!key_var:-}" ]; then
  die "$key_var is not set; export it in this shell (this script never reads keys from files)"
fi
if ! [[ $cap =~ ^[0-9]+(\.[0-9]+)?$ ]] || ! node -e 'process.exit(Number(process.argv[1]) > 0 ? 0 : 1)' "$cap"; then
  die "--cap needs a dollar amount above 0: $cap"
fi

tasks=()
if [ $# -gt 0 ]; then
  tasks=("$@")
else
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in '' | '#'*) continue ;; esac
    tasks+=("$line")
  done <"$here/tasks.txt"
fi
[ ${#tasks[@]} -gt 0 ] || die 'no tasks to run'
for t in "${tasks[@]}"; do
  [[ $t =~ $name_re ]] || die "not a task name: $t"
done

[ -n "$jobs_dir" ] || jobs_dir=${HOME:?}/.cache/houston-bench/jobs
mkdir -p "$jobs_dir" || die "cannot create $jobs_dir"
jobs_dir=$(cd "$jobs_dir" && pwd)
job_dir=$jobs_dir/$job
entry=$jobs_dir/$job.agent.json
spend_file=$jobs_dir/$job.spend
[ ! -e "$job_dir" ] || die "$job_dir already exists; pick a new job name"

entry_args=()
mounts=''
if [ -n "$pkg" ]; then
  [ -z "$release" ] || die '--pkg and --release are alternatives'
  [ -f "$pkg" ] || die "no package at $pkg"
  pkg_name=$(basename "$pkg")
  pkg=$(cd "$(dirname "$pkg")" && pwd)/$pkg_name
  entry_args=(--pkg "$pkg" --label "${label:-local}")
  # Bind the tarball alone, never the folder it sits in: the agent and the task's own code
  # can read everything the container is given.
  mounts=$(node -e 'process.stdout.write(JSON.stringify([{ type: "bind", source: process.argv[1], target: "/opt/houston-pkg/" + process.argv[2], read_only: true }]))' "$pkg" "$pkg_name")
elif [ -n "$label" ]; then
  die '--label goes with --pkg'
elif [ -n "$release" ]; then
  entry_args=(--release "$release")
fi
node "$here/agent-entry.mjs" "$here/agent.json" ${entry_args[@]+"${entry_args[@]}"} >"$entry" || exit 2

args=(run -d "$dataset")
for t in "${tasks[@]}"; do args+=(--include-task-name "terminal-bench/$t"); done
args+=(--agent acp --ak "registry_entry_path=$entry" -m "$model" --ae "$key_var=\${$key_var}" -y --env docker)
[ -z "$mounts" ] || args+=(--mounts "$mounts")
args+=(-n "$conc" --job-name "$job" -o "$jobs_dir")

echo "run.sh: ${#tasks[@]} tasks, cap \$$cap$([ "$dry" -eq 1 ] && echo ', dry run (placeholder key)')" >&2
printf 'run.sh: %q' "$harbor" >&2
printf ' %q' "${args[@]}" >&2
echo >&2

# Harbor's task containers are compose projects named after the trial (<trial>__env,
# <trial>__verifier__...). Remove only those, never anyone else's containers.
remove_containers() {
  command -v "$docker" >/dev/null 2>&1 || {
    echo "run.sh: $docker not found; check for this job's containers by hand" >&2
    return
  }
  local prefixes d id project p
  prefixes=$(for d in "$job_dir"/*/; do [ -d "$d" ] && basename "$d"; done | tr '[:upper:]' '[:lower:]')
  [ -n "$prefixes" ] || return
  "$docker" ps -a --format '{{.ID}} {{.Label "com.docker.compose.project"}}' 2>/dev/null |
    while read -r id project; do
      while read -r p; do
        case $project in
          "$p"__*)
            "$docker" rm -f "$id" >/dev/null 2>&1 && echo "run.sh: removed container $id ($project)" >&2
            break
            ;;
        esac
      done <<<"$prefixes"
    done
}

stopped=''
stop_job() {
  kill -TERM "$pid" 2>/dev/null
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$grace" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "run.sh: Harbor did not stop within ${grace}s; killing it" >&2
    kill -KILL "$pid" 2>/dev/null
  fi
  remove_containers
}
# shellcheck disable=SC2329 # invoked by the trap below
on_signal() {
  [ -n "$stopped" ] && return
  stopped=signal
  echo "run.sh: interrupted; stopping $job" >&2
  stop_job
}

# Harbor starts with SIGHUP ignored: when the terminal closes, it would otherwise die at once
# without its teardown and leave its containers running. on_signal stops it instead.
if [ "$dry" -eq 1 ]; then
  (
    trap '' HUP
    exec env "$key_var=$dry_key" "$harbor" "${args[@]}"
  ) &
else
  (
    trap '' HUP
    exec "$harbor" "${args[@]}"
  ) &
fi
pid=$!
# A background job ignores Ctrl-C, and Harbor ignores the hangup, so pass either on to it as
# the SIGTERM it handles.
trap on_signal HUP INT TERM

# A guard that cannot read the spend fails closed: three failed checks in a row stop the job.
failures=0
while kill -0 "$pid" 2>/dev/null; do
  sleep "$poll" &
  wait $! 2>/dev/null
  [ -d "$job_dir" ] || continue
  node "$here/spend.mjs" "$job_dir" --cap "$cap" >"$spend_file"
  rc=$?
  [ -z "$stopped" ] || continue
  case $rc in
    0) failures=0 ;;
    3)
      stopped=cap
      echo "run.sh: reported spend reached the \$$cap cap; stopping $job" >&2
      stop_job
      ;;
    *)
      failures=$((failures + 1))
      echo "run.sh: the spend check failed (exit $rc)" >&2
      if [ "$failures" -ge 3 ]; then
        stopped=unknown
        echo "run.sh: spend unknown after $failures failed checks; stopping $job" >&2
        stop_job
      fi
      ;;
  esac
done
wait "$pid"
status=$?
trap - HUP INT TERM

if [ -d "$job_dir" ]; then
  node "$here/spend.mjs" "$job_dir" | tee "$spend_file"
fi
case $stopped in cap | unknown) exit 3 ;; esac
exit "$status"
