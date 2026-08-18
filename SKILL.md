---
name: ship-it
description: >
  Ship code: commit granularly, push, monitor GitHub Actions, create PR,
  follow up on PR review comments (address, reply, resolve).
  Stages selected via arguments; defaults to full pipeline.
user-invocable: true
disable-model-invocation: true
argument-hint: "[commit | push | monitor | pr | follow-up]"
---

# Ship it

Progressive shipping pipeline. Runs one or more stages depending on `$ARGUMENTS`.

## Usage

- `/ship-it` (no args) = commit + push + monitor CI
- `/ship-it commit` = commit only
- `/ship-it push` = commit + push
- `/ship-it monitor` = monitor CI only
- `/ship-it pr` = commit + push + create PR using the `pr-guidelines` skill, then monitor CI
- `/ship-it follow-up` = review comments on the session's PRs: address, reply, resolve (runs commit + push + monitor when fixes produce commits)

## Stage Dispatch

Parse `$ARGUMENTS` (lowercased, trimmed) to determine which stages to execute:

| Argument | Stages |
|----------|--------|
| *(empty)* | commit, push, monitor |
| `commit` | commit |
| `push` | commit, push |
| `monitor` | monitor |
| `pr` | commit, push, pr, monitor |
| `follow-up` | follow-up |

If the argument doesn't match any of the above, tell the user the available options and stop.

---

## Stage: Commit

Commit changes granularly, in isolated commits, as a very senior engineer would:

- Group related changes into focused, atomic commits
- Each commit should represent one logical change
- Write clear, conventional commit messages
- If there are no changes to commit, skip this stage and notify the user

### Conventional Commit Format

Keep commits atomic and descriptive. Common prefixes:

- `feat: add user authentication endpoint`
- `fix: resolve null pointer in payment processing`
- `refactor: extract validation logic to service class`
- `test: add coverage for subscription renewal`
- `docs: update API documentation for v2 endpoints`
- `chore: bump dependency versions`

Scopes are welcome when they add clarity: `feat(auth): ...`, `fix(setup): ...`.

### Git Hooks

This project may have Git hooks (pre-commit, commit-msg, etc.). If a hook fails:

1. Read the hook's error output
2. Fix the issues it reports
3. Re-attempt the commit
4. Do NOT bypass hooks with `--no-verify`

---

## Stage: Push

Push committed changes to the remote repository.

- Push to the current branch's upstream (or set upstream if needed)
- If a pre-push hook fails, fix the errors and retry
- Do NOT use `--force` unless explicitly instructed

---

## Stage: Monitor

Monitor GitHub Actions for the current branch, checking at ~1 minute intervals.

Useful commands:

- `gh pr checks <number>` — check rollup for a PR
- `gh run list --branch <branch> --limit 5` — recent workflow runs
- `gh run view <run-id> --log-failed` — logs of the failed jobs only

### Monitoring Loop

1. Check workflow status
2. If **running/pending**: wait ~1 minute, check again
3. If **passed/succeeded**: report success and stop
4. If **failed**: report which job(s) failed, investigate logs, fix the errors, then commit + push the fix and restart monitoring

### No-op merges

After merging changes that need no test or deploy (docs-only, dependabot bumps, config no workflow consumes), don't monitor the triggered main-branch runs — cancel them: `gh run list --branch main --limit 3` to find them, `gh run cancel <run-id>` for each. Only when the merge provably touches nothing tested or deployed; when unsure, monitor as usual.

---

## Stage: PR

Create a pull request for the current branch.

1. Use the `pr-guidelines` skill for the title and description format
2. Create the PR with `gh pr create`
3. Report the URL of the created PR

---

## Stage: Follow-up

Sweep the session's pull requests for review feedback: address it, reply, and resolve — the full loop, not just a report.

### Which PRs

The PRs being worked on in this session, resolved in order:

1. PRs created or discussed earlier in this conversation (numbers, URLs, `/ship-it pr` output)
2. Otherwise, the open PR for the current branch: `gh pr view --json number,url,title`
3. If neither yields a PR, ask which PR(s) to target using AskUserQuestion

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

Also gather feedback that lives outside review threads:

- PR-level comments: `gh pr view <number> --json comments`
- Review summaries (especially "changes requested"): `gh pr view <number> --json reviews`

### Triage each unresolved thread

Every thread gets exactly one of three outcomes — never silently skip one:

- **Fix**: the comment asks for a change that is correct or cheap. Implement it.
- **Answer**: a question, or a suggestion better met with explanation than code. Reply, no code change.
- **Escalate**: disagreement with the reviewer, scope or product calls, anything needing the user's input. Batch ALL escalations into a single AskUserQuestion call (one question per thread), then act on the answers as Fix or Answer.

### Apply, reply, resolve

Order matters — replies reference commits, so code lands first:

1. Implement all Fix items for this PR
2. Run the **commit** and **push** stages for those changes
3. Reply to every triaged thread, referencing the fix commit SHA where one exists. Write replies in the user's voice — load the `fgilio-voice` skill before writing them.
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

End with a per-PR summary: threads fixed / answered / escalated / left open for the reviewer, plus CI status.
