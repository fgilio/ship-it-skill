---
name: ship-it
description: >
  Ship code: commit granularly, push, monitor GitHub Actions, create PR,
  follow up on PR review comments (address, reply, resolve, and hand
  check-shaped findings to bonsai:guard).
  Stages selected via arguments; defaults to full pipeline.
user-invocable: true
disable-model-invocation: true
argument-hint: "[commit | push | monitor | pr | follow-up | fu]"
---

# Ship it

## Stage Dispatch

Parse `$ARGUMENTS` (lowercased, trimmed) to determine which stages to execute:

| Argument          | Stages                    |
| ----------------- | ------------------------- |
| _(empty)_         | commit, push, monitor     |
| `commit`          | commit                    |
| `push`            | commit, push              |
| `monitor`         | monitor                   |
| `pr`              | commit, push, pr, monitor |
| `follow-up`, `fu` | follow-up                 |

If the argument doesn't match any of the above, tell the user the available options and stop.

## Stage: Commit

Commit in focused, atomic commits, one logical change each, with conventional commit messages: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, plus an optional scope (`feat(auth): ...`). If there are no changes to commit, skip this stage and notify the user.

If a commit or push hook fails, fix what it reports and retry. Do NOT bypass hooks with `--no-verify`.

## Stage: Push

Push to the current branch's upstream (or set upstream if needed). Do NOT use `--force` unless explicitly instructed.

## Stage: Monitor

Monitor GitHub Actions for the current branch, checking at ~1 minute intervals:

1. If **running/pending**: wait ~1 minute, check again
2. If **passed/succeeded**: report success and stop
3. If **failed**: report which job(s) failed, investigate logs, fix the errors, then commit + push the fix and restart monitoring

### No-op merges

After merging changes that need no test or deploy (docs-only, dependabot bumps, config no workflow consumes), don't monitor the triggered main-branch runs — cancel them: `gh run list --branch main --limit 3` to find them, `gh run cancel <run-id>` for each. Only when the merge provably touches nothing tested or deployed; when unsure, monitor as usual.

## Stage: PR

Create the PR with `gh pr create`, using the `pr-guidelines` skill for the title and description format. Report the URL of the created PR.

## Stage: Follow-up

Sweep the session's pull requests for review feedback: address it, reply, and resolve — the full loop, not just a report.

### Which PRs

The PRs being worked on in this session, resolved in order:

1. PRs created or discussed earlier in this conversation (numbers, URLs, `/ship-it pr` output)
2. Otherwise, the open PR for the current branch: `gh pr view --json number,url,title`
3. If neither yields a PR, ask which PR(s) to target using AskUserQuestion or request_user_input

Run the loop below for each PR in scope.

### Gather feedback

Get `<owner>` and `<repo>` for the commands below from `gh repo view --json owner,name`.

Review-thread resolution state is GraphQL-only; `gh pr view` does not expose it. Fetch every thread with:

```bash
gh api graphql \
  -f query='query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line comments(first:50){nodes{databaseId author{login} body}}}}}}}' \
  -f owner=<owner> -f repo=<repo> -F pr=<number>
```

Keep two IDs per thread: the thread `id` (needed to resolve it) and the first comment's `databaseId` (needed to reply). Skip threads where `isResolved` is true; treat `isOutdated` threads as still needing a reply. If `hasNextPage` is true, re-run with an added `$after:String` variable, `reviewThreads(first:100, after:$after)`, and `-f after=<endCursor>`.

Also read feedback that lives outside review threads, especially "changes requested" reviews: `gh pr view <number> --json comments,reviews`.

### Guardrails

When the `bonsai:guard` skill is available, run it once, on every PR in scope together, with `--no-reply`, before the first triage. It settles with the user which findings get a check, opens one guardrail PR per check from the default branch, and returns which threads each one covers. Its PRs build in the background, so triage and fix while they do, and reply only once it reports.

### Triage each unresolved thread

Every thread gets exactly one of three outcomes — never silently skip one:

- **Fix**: the comment asks for a change that is correct or cheap. Implement it.
- **Answer**: a question, or a suggestion better met with explanation than code. Reply, no code change.
- **Escalate**: disagreement with the reviewer, scope or product calls, anything needing the user's input. Batch ALL escalations into a single AskUserQuestion or request_user_input call (one question per thread), then act on the answers as Fix or Answer.

### Apply, reply, resolve

Order matters — replies reference commits, so code lands first:

1. Implement all Fix items for this PR
2. Run the **commit** and **push** stages for those changes
3. Reply to every triaged thread, referencing the fix commit SHA and the guardrail PR that covers it, where each exists. Write replies in the user's voice — load the `fgilio-voice` skill before writing them.
   - Review thread reply (`in_reply_to` takes the first comment's `databaseId`):
     ```bash
     gh api repos/<owner>/<repo>/pulls/<number>/comments -F in_reply_to=<databaseId> -f body='...'
     ```
   - PR-level comment reply: `gh pr comment <number> --body '...'`
4. Resolve each addressed thread (GraphQL-only, uses the thread `id`):
   ```bash
   gh api graphql \
     -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' \
     -f id=<threadId>
   ```
   Resolve when the fix is pushed or the question is answered. Leave a thread unresolved when the reply asks the reviewer something or awaits their re-review — resolving those buries the conversation.
5. If any commits were pushed, run the **monitor** stage

### Report

End with a per-PR summary: threads fixed / answered / escalated / left open for the reviewer, the guardrail PRs opened, plus CI status.
