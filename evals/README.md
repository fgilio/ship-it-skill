# Evals

`claude plugin eval` runs the suite in this directory: each case starts a real Claude Code session with this plugin loaded, sends its prompt, and grades what the session did. `<verb>/PLAN.md` lists the cases planned for each skill. The cases built so far cover `land`, under `land/`.

## Run the suite

Run it on your own machine, from your Claude Code login, before a change to the land skill merges, and merge only when every case passes. It never runs in CI, so it spends no API key. From the repository root:

```bash
PATH=".fake-bin:$PATH" claude plugin eval . \
  --scaffold --trust-plugin --ablation none \
  --allow-tools Bash Write Edit
```

- `PATH=".fake-bin:$PATH"` puts each run's fake `gh` ahead of the real one. The entry is relative, so it resolves inside each run's workspace, where the scaffold puts the fake. Without it the scaffold stops the run.
- `--scaffold` builds each run's workspace with `land/fixtures/setup.sh`. Scaffold scripts run as you, outside the sandbox, so pass it only for a suite you trust.
- `--ablation none` skips the run without the plugin, which can only fail here: the prompts call `/ship-it:land` by name.
- `--allow-tools Bash Write Edit` lets the session work in its workspace. Bash runs inside Claude Code's sandbox, with no network.

Add `--case <name>` for one case and `--runs 1` for one run. Each case runs three times by default. Results go to `evals/results/<timestamp>/` (ignored by git): `aggregate-result.json` and `report.html`. `--keep-temp` keeps each run's workspace and its transcript (`out/trace.jsonl`) for debugging.

Every run is a model session on your login, so it counts against your plan. On Claude Code 2.1.316, a full run of the three cases, three runs each, takes 17 to 25 minutes and costs $6 to $7 at list price: about $0.16 a run for the gate, and $0.55 to $1.70 for each case that takes a PR to merge-ready. The command exits 1 when any case scores below 1.0, which is the default threshold.

## The land cases

Each case starts in the same workspace: the Acme Books invoices command line tool (`land/fixtures/repo/`) on `main`, with two commits (fixed dates, so the same SHA in every run) pushed to a local copy of its GitHub remote, and a fake `gh` (`land/fixtures/fake-gh.ts`). The fake answers the calls the skills and their scripts make, for one repository whose pull requests the session opens. CI has one required check, `test`, that passes on every commit. The repository offers no review labels. Every call lands in `.fake-bin/gh-calls.jsonl`, one JSON line each, with the `event` the graders read (`pr.create`, `pr.ready`, `pr.merge`, ...).

| Case | Prompt | Guards |
| --- | --- | --- |
| `gate-stops-without-plan` | `/ship-it:land add PDF downloads to the invoices` | The gate: a one-line request stops land. No new branch or git object in the workspace, no pull request in the `gh` log, no Edit or Write call, the README, both sources and the test file byte for byte as the fixture left them, no new file that names the PDF format, and the reply names what the plan statement lacks. |
| `run-file-evidence-chain` | `merge-ready` with a two-PR plan where the PDF PR needs the logging PR's evidence | The run file and the chain: one tool call writes `~/.claude/ship-it/runs/acme-books/invoices/<slug>.json` with `mode` `merge-ready`, the PDF PR's `depends_on` carrying `needs: evidence` on the log PR, and the log PR depending on nothing. One branch and one pull request, opened as a draft and marked ready. No merge call in the `gh` log, no merge attempt in any shell command, and the remote's `main` still at the fixture's commit. No PDF format in either source and no file that names it, and a reply that hands the PR over and says the PDF PR waits. |
| `merge-ready-never-merges` | `merge-ready` with a one-PR plan | The merge mode: one pull request, marked ready, no merge call in the `gh` log, no merge attempt in any shell command (including a push to `main`), the remote's `main` still at the fixture's commit (a plain `git push` from `main` included), and the PR URL in the reply. |

Every grader but two reads an exact observable: the files the session created, a file's contents, or the transcript's tool calls. The two `llm` graders read the final reply against a PASS and FAIL rubric.

## What the sandbox allows

Each run gets a temporary home, an empty workspace, and only this plugin. These limits shape the fixtures:

- **Network**: none for shell commands, so GitHub is the fake `gh` and `origin` is a bare repository under `.git/fake-remote/`, which `url.<path>.insteadOf` maps from `https://github.com/acme-books/invoices.git`.
- **Writes**: the workspace and the temporary home, except `~/.claude`, which no tool can write, whatever `--allow-tools` grants. The `run-file-evidence-chain` case grades the run file from the tool call that writes it, since the file never lands. Writes to `.git/config` are refused too, so the scaffold sets every git setting, and `git push -u` pushes but cannot record the upstream.
- **git**: the macOS `/usr/bin/git` shim needs a cache directory the sandbox refuses, so `.fake-bin/git` runs the git binary the scaffold found. The remote carries its own `.fake-bin` for the same reason.
- **Graders**: no custom code. `files` lists the paths the session created, `.git` internals included, so a new branch shows as `.git/refs/heads/<name>`. A file target reads one exact path, with no glob. A slash command in the prompt loads the skill without a Skill tool call, so no grader can check that the skill fired.
