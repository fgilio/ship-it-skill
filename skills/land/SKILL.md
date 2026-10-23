---
name: land
description: >
  Land a change the session already understands: implement it, prove it, review it locally and through review rounds, then stop at merge-ready, or merge, deploy and verify it in the merge mode the user picks. Use only when the session holds a plan or clear decisions about what to build. Merges and approves deploys only in a merge mode that says so.
user-invocable: true
disable-model-invocation: true
argument-hint: "[merge-ready | merge | auto-merge] [--guard]"
---

# Land

Land takes a known change through a fixed line of gates, and **every gate leaves an artifact** the next gate reads. A PR reaches the user with its proof, its reading guide and a decision on every finding, so the merge takes a short read.

To follow another ship-it skill, read `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md`. Inside that file, `${CLAUDE_SKILL_DIR}` means `${CLAUDE_SKILL_DIR}/../<name>`, and `$ARGUMENTS` means the arguments land passes. References live in `${CLAUDE_SKILL_DIR}/../../references/`.

## 0. Continue

When a run file of this repository (section 4) still has PRs that are not done, ask once whether to continue it. Yes: check each PR's state on GitHub, start each at its recorded step, and skip sections 1 to 3. No: start at the gate, and the old run file stays as the record.

## 1. Gate

The session holds a plan, or decisions clear enough to write one. Write the plan statement: the goal, the scope and what stays out of it, and how to tell the change works. When the session cannot fill one of the three, stop, list what is missing, and implement nothing. A ticket or a one-line request is the start of a planning conversation, and land starts after it.

## 2. Shape

The artifact is the PR plan: each PR with its title, its scope, and the PRs it depends on.

- One PR when the change reads well as one.
- A preparation PR (moves, renames, refactors that keep behavior) splits from the behavior change only when the split makes the behavior change easier to review.
- **Wide, not deep**: each PR merges into the default branch on its own. Dead code, or a feature behind a flag that is off, merges fine.
- A PR depends on another only when it needs that PR's code. Code two PRs share lives once, in the lowest PR that needs it.

## 3. Ask

One AskUserQuestion, holding only the questions `$ARGUMENTS` does not answer:

- **Merge mode** (`merge-modes.md`): `merge-ready` (recommended), `merge`, or `auto-merge`. When the plan holds a chain of dependent PRs, the question says that in `merge-ready` mode each link waits for the user's merge.
- **Guardrails**, only when the session has the `bonsai:guard` skill: no (recommended), or yes, so that each review round hands its findings to guard.

## 4. Run file

Write the run to `~/.claude/ship-it/runs/<owner>/<repo>/<plan slug>.json` before the first PR, and update it after every step. The plan slug is the goal in a few kebab-case words (`invoice-pdf-download`). A PR's `base` is the commit its branch starts from: the default branch's commit it was cut from, or its parent's last commit for a PR taken ahead.

```json
{
  "plan": "Customers can download each invoice as a PDF",
  "mode": "merge-ready",
  "guard": false,
  "prs": [
    { "title": "Render invoices to PDF", "branch": "invoice-pdf", "depends_on": [], "number": 41, "step": "review", "base": "9b1e0c2", "proof_head": "3f2c1aa" }
  ],
  "waiting": ["Hide voided invoices from the download list?"]
}
```

## 5. Each PR

PRs move in the plan's order, like a conveyor. A PR that depends on another starts its review rounds only after that PR merged and its own branch was rebased onto the default branch, so every review reads the code the PR will merge onto. While a PR waits for reviews, CI, a merge or a deploy, work on the next PR whose dependencies merged. A PR whose parent has not merged yet can go ahead through steps 2 to 5 on a branch cut from its parent's branch, and opens only after step 10 rebased it.

For each PR:

1. **Branch** from the default branch, or from the parent's branch for a PR taken ahead, named the way the repository's recent branches are.
2. **Implement.**
3. **Local checks**: the test, static analysis and format commands the repository's CLAUDE.md, AGENTS.md or CI workflow names. All green before the next step. The artifact is each command with its result.
4. **Prove**: follow `proof.md`. The artifact is the test matrix. Record the head it ran on as `proof_head`.
5. **Local review**: the `codex-partner` skill's review mode against the base branch when the session has it, since a second model reads the code independently, and the `code-review` skill otherwise. Fix every P0 and P1, and each P2 that holds up against the code, then run the checks and review again. After three reviews, a P0 or P1 still open is escalated as blocked for this PR, and the other PRs go on.
6. **Open the PR**: follow the `pr` skill. The description carries the proof and the reading guide.
7. **Review rounds**: follow the `review` skill, with `--guard` when the user chose guardrails.
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

## 7. Report

The final message holds, for each PR: its URL and state (merged, merge-ready or blocked), the review rounds with their decisions, the proof's verdict, the deploy and verify results, the findings a check could have caught (listed as guardrail candidates, and built only with guardrails on), and every question still waiting. Send it as a push notification too, in one line.
