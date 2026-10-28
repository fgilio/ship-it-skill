---
name: deploy
description: >
  Merge a ready pull request, watch its deploy until it is live, and approve the deploy's manual gates. Use when the user wants the agent to merge and ship, or after land in a merge mode that merges. Invoking it is the user's permission to merge and to approve those gates.
user-invocable: true
disable-model-invocation: true
argument-hint: "[<PR number or URL>] [--auto]"
---

# Deploy

Merging and approving the deploy's gates are the actions this skill exists for, so the user's invocation, or a merge mode the user picked in land, is the permission for both. Every other production change stays outside it.

GitHub calls go through `gh` or the GitHub MCP tools, whichever `${CLAUDE_SKILL_DIR}/../../references/github.md` picks: read it before the first GitHub call.

## 1. Ready

Read the PR (the one in `$ARGUMENTS`, or the current branch's):

```bash
gh pr view <number> --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName
```

It is ready when it is open, not a draft, `mergeable` is `MERGEABLE`, and `mergeStateStatus` is `CLEAN` (or `HAS_HOOKS`). `UNKNOWN` means GitHub is still computing it: read again after 10 seconds. With `--auto`, a PR whose only gap is checks still running counts as ready, since GitHub merges it when they pass. Anything else is blocked: escalate with the reason, following `${CLAUDE_SKILL_DIR}/../../references/escalation.md`. A required approval that is missing is the user's to give, and the skill never works around it.

## 2. Merge

Use the merge method the repository sets for the user: `gh repo view --json viewerDefaultMergeMethod` answers `SQUASH`, `MERGE` or `REBASE`, which becomes the flag `--squash`, `--merge` or `--rebase`.

Pass the head checked in step 1, so a commit pushed since then cannot merge without its own checks:

- Without `--auto`: `gh pr merge <number> --<method> --match-head-commit <headRefOid>`.
- With `--auto`: `gh pr merge <number> --auto --<method> --match-head-commit <headRefOid>`.

When GitHub refuses because the head moved, the new head goes back through the gates that brought the PR here (for land, the close checklist).

Either command can return before the merge happens: auto-merge waits for checks, and a merge queue waits its turn. Wait as a background command until `gh pr view <number> --json state,mergeCommit` shows `MERGED` with a merge commit. A PR that closes without merging is escalated as blocked, and one still waiting after an hour is escalated as can wait.

Record the merge commit's SHA.

## 3. Find the deploy

How a merge reaches production differs per repository. Find it in this order, and stop at the first that applies:

1. GitHub deployments for the merge commit: `gh api "repos/<owner>/<repo>/deployments?sha=<merge sha>"`.
2. Actions runs for the merge commit on the default branch: `gh run list --commit <merge sha>`, read for jobs that deploy (an `environment:`, a deploy step).
3. The workflow files (`.github/workflows/*.yml`): a job that runs on a push to the default branch and deploys means a run is coming.
4. The repository's CLAUDE.md, AGENTS.md, README or deploy docs, naming another system the session reaches with a CLI or a tool.

Deployments and runs take a minute or two to appear after a merge. When 1 and 2 find nothing yet, look again every 30 seconds for up to 5 minutes, and longer when 3 says a run is coming.

The artifact is the deploy path in one line. When none applies after that wait, the repository ships nothing on merge: say so and stop, with no verify.

## 4. Watch, and approve gates

Watch the deploy as a background command until it ends, following `${CLAUDE_SKILL_DIR}/../../references/ci-watch.md` for Actions runs.

A run waiting for a manual approval lists its gates:

```bash
gh api repos/<owner>/<repo>/actions/runs/<run id>/pending_deployments
```

Approve each gate the user can approve (`current_user_can_approve` is true):

```bash
gh api -X POST repos/<owner>/<repo>/actions/runs/<run id>/pending_deployments \
  -F "environment_ids[]=<environment id>" -f state=approved -f comment="Approved by ship-it deploy for PR #<number>"
```

When GitHub refuses, or `current_user_can_approve` is false (an environment that forbids approving your own deploy, or a reviewer list without the user), escalate as blocked with the run's URL. Never look for another way through: no other account, no admin bypass, no change to the environment's rules.

A failed deploy is escalated as blocked, with the failed job's log. When production ran part of the deploy and now misbehaves, it is a production problem instead.

## 5. Live

The deploy counts as live when it finished successfully, and, when the repository documents a way to read the version that runs (a health or version endpoint, a CLI command), that version is the merge commit. The artifact is that evidence.

Then follow `${CLAUDE_SKILL_DIR}/../verify/SKILL.md` for the merge commit, with `${CLAUDE_SKILL_DIR}` in that file meaning `${CLAUDE_SKILL_DIR}/../verify`.

## Report

The merge commit, the deploy path, each gate approved, and the evidence that the deploy is live.
