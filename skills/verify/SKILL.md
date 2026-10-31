---
name: verify
description: >
  Check production after a deploy: errors, logs, data and uptime, against the hour before it, right away and again two hours later. Use after a deploy the session shipped, or to ask whether a release is healthy. Reads production and never changes it. Start it only when the user asks for it by name (/ship-it:verify).
user-invocable: true
argument-hint: "[<PR number or URL> | <commit>]"
---

# Verify production

Compare production after the deploy with production before it, on the signals the change can move. Every check reads, and nothing here writes to a production system.

## 1. What to watch

From the PR (the one in `$ARGUMENTS`, or the PR of the commit) read what changed and which paths it touches: endpoints, jobs, commands, tables, the feature it adds. The artifact is the watch list: each thing the change can break, and the signal that would show it.

## 2. Signals

Find the production signals the session can read: the ones the repository's CLAUDE.md, AGENTS.md or runbooks name (error tracker, log search, dashboards, a read-only database), and the session's tools for them (an error-tracker tool, a log search tool, an uptime monitor, read-only SQL). The artifact is the list of signals, each with how to read it. When the session reaches none, say so and stop: the deploy is live and unverified.

## 3. Check

Wait until the deploy has served traffic for 10 minutes. Then compare, for each signal, the time since the deploy with the same span before it:

- New error groups since the deploy, and error rates against the span before.
- Log lines from the touched paths: warnings, failures, retries.
- Data the change writes, read back with a read-only query: right shape, right values, nothing missing.
- Uptime and health checks.

The artifact is a verdict per signal: **healthy**, **regression** with its evidence, or **no data** (the touched path saw no traffic yet).

## 4. Check again

Check again two hours after the deploy, the same way. Schedule it with the harness's wake-up tool, or a background timer command where it has none. In a harness with neither, tell the user what to check and when.

## 5. Regression

A regression is a production problem: escalate it following `${CLAUDE_SKILL_DIR}/../../references/escalation.md`, with the evidence. In the same message, open a revert PR ready to merge, and merge it only on the user's word. GitHub's revert reverses the whole PR, whatever the merge method was (a squash, a merge commit, or several rebased commits):

```bash
gh api graphql \
  -f query='mutation($id:ID!){revertPullRequest(input:{pullRequestId:$id}){revertPullRequest{url}}}' \
  -f id="$(gh api 'repos/{owner}/{repo}/pulls/<number>' --jq .node_id)"
```

When GitHub cannot build the revert (a conflict with later commits), revert the PR's commits on a branch by hand, then follow the `pr` skill. A session that reaches GitHub through MCP (`${CLAUDE_SKILL_DIR}/../../references/github.md`) has no revert call, so it reverts by hand too.

## Report

The watch list, each signal's verdict at each check, and the revert PR when there is one.
