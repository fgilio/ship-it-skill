---
name: land
description: >
  Land a change the session already understands: implement it, prove it, review it locally and through review rounds, then stop at merge-ready, or merge, deploy and verify it in the merge mode the user picks. Use only when the session holds a plan or clear decisions about what to build. Merges and approves deploys only in a merge mode that says so.
user-invocable: true
disable-model-invocation: true
argument-hint: "[merge-ready | merge | auto-merge] [--guard | --guard=rounds]"
---

# Land

Land takes a known change through a fixed line of gates, and **every gate leaves an artifact** the next gate reads. A PR reaches the user with its proof, its reading guide and a decision on every finding, so the merge takes a short read.

The aim is to deploy as often as possible: small PRs, each merged and deployed on its own as soon as it is ready. The plan's shape decides how often that can happen, so shape for flow: many PRs side by side, short chains.

To follow another ship-it skill, read `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md`. Inside that file, `${CLAUDE_SKILL_DIR}` means `${CLAUDE_SKILL_DIR}/../<name>`, and `$ARGUMENTS` means the arguments land passes. References live in `${CLAUDE_SKILL_DIR}/../../references/`.

GitHub calls below use `gh`. When `gh api repos/{owner}/{repo}` fails (no `gh`, logged out, or no access to this repository), read `${CLAUDE_SKILL_DIR}/../../references/github.md` before the next GitHub call.

## 0. Continue

When a run file of this repository (section 4) still has PRs that are not done, or a `guard.when` of `end` with a `guard.status` other than `done`, ask once whether to continue it. Yes: check each PR's state on GitHub, start each at its recorded step, run section 7 when it applies, and skip sections 1 to 3. A run file whose `guard` is `true` or `false` was written before `guard.when` existed: read `true` as `rounds` and `false` as `off`. No: start at the gate, and the old run file stays as the record.

## 1. Gate

The session holds a plan, or decisions clear enough to write one. Write the plan statement: the goal, the scope and what stays out of it, and how to tell the change works. When the session cannot fill one of the three, stop, list what is missing, and implement nothing. A ticket or a one-line request is the start of a planning conversation, and land starts after it.

## 2. Shape

The artifact is the PR plan: each PR with its title, its scope, and the PRs it depends on.

- One PR when the change reads well as one.
- A preparation PR (moves, renames, refactors that keep behavior) splits from the behavior change only when the split makes the behavior change easier to review.
- **Wide, not deep**: each PR merges into the default branch on its own. Dead code, or a feature behind a flag that is off, merges fine.
- A PR **needs the code** of another only when it calls or changes that PR's code. Code two PRs share lives once, in the lowest PR that needs it.
- A PR **needs the evidence** of another when it should be built on what production shows after that PR ships: logging or metrics that show how a path behaves today, a flag turned on for a few users first. The plan names the evidence, where to read it, and how long it takes to gather.

## 3. Ask

One AskUserQuestion, holding only the questions `$ARGUMENTS` does not answer:

- **Merge mode** (`merge-modes.md`): `merge-ready` (recommended), `merge`, or `auto-merge`. When the plan holds a chain of dependent PRs, the question says that in `merge-ready` mode each link waits for the user's merge, and a link that needs evidence also waits for the user's deploy.
- **Guardrails**, only when the session has the `bonsai:guard` skill. `--guard` answers it with `end`, `--guard=rounds` with `rounds`:
  - `end` (recommended): guard runs once, after the last PR, over every PR of the run (section 7). It reads every round together, so one guardrail covers a mistake that came back across rounds and PRs, and a finding a later round withdrew gets none.
  - `rounds`: each review round hands its findings to guard, so a check can open while the PR is still in review.
  - `off`: no guard. The report lists the findings a check could have caught.

## 4. Run file

Write the run to `~/.claude/ship-it/runs/<owner>/<repo>/<plan slug>.json` before the first PR, and update it after every step. The plan slug is the goal in a few kebab-case words (`invoice-pdf-download`). A PR's `base` is the commit its branch starts from: the default branch's commit it was cut from, or its parent's last commit for a PR taken ahead. `guard.when` is `end`, `rounds` or `off`. With `end`, `guard.status` is `pending` until section 7 runs, `waiting` while guard holds candidates for a later decision round, and `done` after, and `guard.prs` lists the PRs its pass covered.

```json
{
  "plan": "Customers can download each invoice as a PDF",
  "mode": "merge-ready",
  "guard": { "when": "end", "status": "pending" },
  "prs": [
    { "title": "Log invoice downloads", "branch": "invoice-download-log", "depends_on": [], "number": 40, "step": "merged", "base": "77ad0e4", "proof_head": "e51b9c3" },
    { "title": "Render invoices to PDF", "branch": "invoice-pdf", "depends_on": [{ "title": "Log invoice downloads", "needs": "evidence" }], "number": 41, "step": "review", "base": "9b1e0c2", "proof_head": "3f2c1aa" }
  ],
  "waiting": ["Hide voided invoices from the download list?"]
}
```

## 5. Each PR

PRs move in the plan's order, like a conveyor. A PR that depends on another starts its review rounds only after that PR merged and its own branch was rebased onto the default branch, so every review reads the code the PR will merge onto. While a PR waits for reviews, CI, a merge or a deploy, work on the next PR whose dependencies merged. A PR that needs a parent's code can go ahead through steps 2 to 5 on a branch cut from its parent's branch before the parent merges, and opens only after step 10 rebased it.

A PR that needs a parent's evidence starts only after the parent is deployed and the evidence is in, since the evidence can change what the PR does. Read it with the signals the `verify` skill finds. Then hold the plan against it: when the evidence changes a later PR, update the plan, and say what changed and why before going on. While the evidence gathers, other PRs go on. When nothing else can, the run stops: schedule a wake-up for when the evidence should be in, or let the user continue, since the run file holds the place.

For each PR:

1. **Branch** from the default branch, or from the parent's branch for a PR taken ahead, named the way the repository's recent branches are.
2. **Implement.**
3. **Local checks**: the test, static analysis and format commands the repository's CLAUDE.md, AGENTS.md or CI workflow names. All green before the next step. The artifact is each command with its result.
4. **Prove**: follow `proof.md`. The artifact is the test matrix. Record the head it ran on as `proof_head`.
5. **Local review**: the `codex-partner` skill's review mode against the base branch when the session has it, since a second model reads the code independently, and the `code-review` skill otherwise. Fix every P0 and P1, and each P2 that holds up against the code, then run the checks and review again. After three reviews, a P0 or P1 still open is escalated as blocked for this PR, and the other PRs go on.
6. **Open the PR as a draft**: follow the `pr` skill with `--draft`. The description carries the proof and the reading guide. Its CI watch is the gate to the rounds: fix each failure and push until CI is green on the head. A review service that reviews every new PR, such as Codex, may answer meanwhile. Never wait for it, since it may not be set up or may stall: its findings go to the first round, which addresses every unresolved finding. When CI is green, mark the PR ready with `gh pr ready <number>`, then watch the head's required checks once more: a workflow may run only when the PR leaves draft, or skip its jobs on a draft. The first round starts when that watch passes.
7. **Review rounds**: follow the `review` skill, with `--guard` when `guard.when` is `rounds`. Only the first round waits for CI, through step 6. Each later round waits only for the previous round's fixes to be pushed and every one of its threads answered and resolved.
8. **Close**: the PR is ready when every line of this checklist holds, and the checklist is the artifact.
   - CI is green on the head.
   - The branch is current with its base. When it is behind, rebase, then run the checks and watch CI again.
   - Every finding has a decision, by the address reports.
   - The proof matches the head. When a fix changed behavior after `proof_head`, run the cases it touched again and update the description.
   - The description describes the final change.
9. **Merge mode**:
   - `merge-ready`: send a push notification and a message with the PR's URL. The user merges. When PRs depend on this one, take them ahead as far as section 5 allows, name the PR to merge next, and stop until the user comes back. The run file holds the place.
   - `merge`: follow the `deploy` skill for this PR. It ends by following the `verify` skill.
   - `auto-merge`: follow the `deploy` skill with `--auto`. It ends by following the `verify` skill.
10. **Next link**: after the merge, rebase each PR that depends on this one onto the default branch: `git fetch origin`, then `git rebase --onto origin/<default branch> <base> <branch>`, with the PR's `base` from the run file. That replays only the PR's own commits, even when the parent was rebased or squash-merged since. Set `base` to the new starting commit, run the local checks, prove again when the rebase changed code the proof covered, push (`--force-with-lease` when the branch was pushed before), and continue at its recorded step.

## 6. Escalate

Follow `escalation.md`. Saved questions go to the user at the end of each review round and at the end of the run.

## 7. Guardrails at the end

With `guard.when` set to `end`, guard runs once every PR of the run has stopped:

- In `merge-ready`, the PR is merge-ready and handed to the user, or merged. A run that stopped for the user's merge of a parent has not stopped until its last link has.
- In `merge` or `auto-merge`, the PR is deployed and verify's first check ended, or verify found no signal it can read and recorded the deploy as live and unverified. A verify check scheduled for later does not hold guard.
- In any mode, the PR is blocked, or it depends on a PR that is blocked.

The scope is every PR of the run with review findings: threads, review bodies or comments from any reviewer, open, merged or blocked alike. When no PR has any, set `guard.status` to `done` and skip guard, since guard called with no PR picks PRs on its own.

Follow `bonsai:guard` once, with those PR numbers, and record them in `guard.prs`. Pass no `--no-reply`: the threads were answered and resolved during the rounds, so guard adds its own reply on each thread a guardrail covers and leaves it resolved. Its guardrail PRs are cut from the default branch and merge on their own, so they never hold a PR of the run. While guard holds candidates for a later decision round, `guard.status` is `waiting`, and the run goes on with guard's next round when the user sends the decisions of the last one. When guard reports none waiting, set it to `done`.

A continued run that takes up a PR that was blocked during the pass, or a PR that depended on it, sets `guard.status` back to `pending` before its first step on that PR. When those PRs stop again, guard runs over them alone, and `guard.prs` gains any it lacked.

## 8. Report

The final message holds, for each PR: its URL and state (merged, merge-ready or blocked), the review rounds with their decisions, the proof's verdict, the deploy and verify results, and every question still waiting. Then the guardrails: guard's table of candidates and PRs, or with `guard.when` set to `off`, the findings a check could have caught. Send it as a push notification too, in one line.
