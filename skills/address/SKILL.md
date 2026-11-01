---
name: address
description: >
  Address review feedback on the session's pull requests: give every finding a decision (fix, answer or escalate), push the fixes, reply on each thread, and resolve it. Use after reviews land on a PR, from people or bots. Replies on review threads. Start it only when the user asks for it by name (/ship-it:address).
user-invocable: true
argument-hint: "[<PR number or URL>...] [--guard]"
---

# Address review feedback

Every finding gets exactly one decision, written on the PR where the next reviewer reads it: **one finding, one decision**. A thread resolved without a reply, or a finding in a review summary that nobody answered, is a decision lost. The next review raises it again, and the next session cannot tell whether anyone weighed it.

GitHub calls below use `gh`. When `gh api repos/{owner}/{repo}` fails (no `gh`, logged out, or no access to this repository), read `${CLAUDE_SKILL_DIR}/../../references/github.md` before the next GitHub call.

## Which PRs

Resolve them in this order:

1. The PR numbers or URLs in `$ARGUMENTS`.
2. The PRs created or discussed earlier in this conversation.
3. The open PR of the current branch: `gh api -X GET 'repos/{owner}/{repo}/pulls' -f head="<owner>:$(git branch --show-current)" -f state=open`, with `<owner>` written out as the login of the repository the branch was pushed to, and the upstream repository in the path for a branch on a fork.
4. When none of these yields a PR, ask which ones with AskUserQuestion.

Run everything below for each PR.

## Gather the findings

Thread resolution is in GraphQL only. Fetch every thread:

```bash
gh api graphql \
  -f query='query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line comments(first:50){nodes{databaseId author{login} body url}}}}}}}' \
  -F owner='{owner}' -F repo='{repo}' -F pr=<number>
```

Keep two ids per thread: the thread `id` to resolve it, and the first comment's `databaseId` to reply. Skip resolved threads. An outdated thread still needs a reply. When `hasNextPage` is true, run the query again with an added `$after:String` variable, `reviewThreads(first:100, after:$after)`, and `-f after=<endCursor>`.

Then read the reviews and comments outside the threads, with the URL of each:

```bash
gh api 'repos/{owner}/{repo}/pulls/<number>/reviews' --paginate --jq '.[] | {html_url, user: .user.login, state, body}'
gh api 'repos/{owner}/{repo}/issues/<number>/comments' --paginate --jq '.[] | {html_url, user: .user.login, body}'
```

A review body often lists findings that have no thread: a summary, or findings on lines outside the diff. Each one is a finding. A body that numbers its items (`M1`, `M2`, … for a checklist, `Q1`, `Q2`, … for questions) holds one finding per number, whose id is the review's `html_url` and the number: every review starts again at `M1`.

The artifact is the findings list: an id (the thread id, or the review's `html_url` with the item's number, or with its position when the body numbers nothing), the reviewer, the file and line when there is one, and the claim.

## Read earlier decisions

Before deciding anything, read the replies already on the PR, and on the other PRs of its stack (the PRs it builds on and the PRs built on it). A finding that repeats one already declined gets a reply linking that decision, and no change. It gets a fresh decision only when it brings a fact the earlier decision did not weigh. A numbered item is settled when an earlier PR comment names its review and its number with a fix or an answer, whatever the review body still shows. A reply that leaves it waiting (on the user, on the reviewer) settles nothing.

## Decide

Group the findings by root cause first. Several findings, often from several reviewers, can share one cause, and one fix settles them all. Each one still gets its own reply.

Each finding gets one of three decisions:

- **Fix**: the finding holds up against the code and the tests, or the change is cheap and harmless. Implement it.
- **Answer**: a question, a suggestion an explanation serves better, or a claim the code or a test disproves. Reply with the evidence and change nothing.
- **Escalate**: what code, tests and earlier decisions cannot settle, such as intent, scope, accepted risk or a product call. A review's numbered questions are product calls, so each one escalates unless an earlier decision settles it. Save it and go on: the other findings do not wait for it. `${CLAUDE_SKILL_DIR}/../../references/escalation.md` sets the channel.

```text
DON'T escalate: "Should this query use the index?" (EXPLAIN answers it)
DO escalate:    "The reviewer wants revoked invoices hidden from customers. Today they stay visible with a badge. Hide them?"
```

In a stack, a fix lands in the lowest PR that owns the code, and the PRs above it are rebased onto it. The reply names the PR and the commit that carry the fix.

## Guardrails

When `$ARGUMENTS` has `--guard` and the session has the `bonsai:guard` skill, run it once, on every PR in scope together, with `--no-reply`, before the first decision. It settles with the user which findings get a check, opens one guardrail PR per check from the default branch, and returns which threads each one covers. Its PRs build in the background, so decide and fix while they do, and reply only once it reports. Guard reads every finding on the PR, resolved threads included, so its map can name a thread an earlier round resolved: reply there too, with the guardrail PR, and leave the thread resolved. End every reply the map covers with the marker line guard returns for it, and carry the markers of the findings outside threads in the PR comment that answers them. A later guard pass reads them to skip what was already built or declined.

## Apply, reply, resolve

Replies cite commits, so code lands first:

1. Implement every Fix.
2. Run the repository's local checks for the touched code: the test, static analysis and format commands its CLAUDE.md, AGENTS.md or CI workflow names. Fix what fails.
3. Commit and push, following `${CLAUDE_SKILL_DIR}/../../references/commit-push.md`: one commit per root cause, and one commit for a review's numbered checklist when none of its fixes changes behavior.
4. Reply to every finding, citing the fix commit's SHA, and the guardrail PR that covers it when there is one. Write in the user's voice: load the `fgilio-voice` skill when the session has it.
   - A thread (`in_reply_to` takes the first comment's `databaseId`):

     ```bash
     gh api 'repos/{owner}/{repo}/pulls/<number>/comments' -F in_reply_to=<databaseId> -f body='...'
     ```

   - Findings without a thread: one PR comment that lists each finding with its decision (fixed in `<sha>`, answered with the reason, or the user's call), naming each numbered item by its review and its number (`<review URL> M2: fixed in <sha>`): `gh api 'repos/{owner}/{repo}/issues/<number>/comments' -F body=@<file>`.
5. Resolve each thread whose fix is pushed, or whose reply settles it:

   ```bash
   gh api graphql \
     -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' \
     -f id=<threadId>
   ```

   Leave a thread open when the reply asks the reviewer something or waits for their review again, and while its finding waits for the user. Resolving those buries the conversation.

6. When commits were pushed, follow `${CLAUDE_SKILL_DIR}/../../references/ci-watch.md`. Inside review rounds the watch runs in the background and the next round goes on without it, as the review skill's step 3 says. A manual gate the watch lists follows that reference's "Manual gates".
7. Ask the saved escalations, all in one AskUserQuestion, one question per finding, each with a recommendation. Act on each answer as Fix or Answer, through steps 1 to 6.

## Report

For each PR: the findings fixed, answered, escalated and left open for the reviewer, the guardrail PRs, the CI result, and one line on behavior:

- **Behavior changed: yes**, with the paths relative to the repository root, when any fix changed what the code does.
- **Behavior changed: no**, when every fix touched only tests, docs, comments or wording, or refactored without changing what the code does.

The review and land skills read that line to decide whether to review again and whether the proof needs a refresh.
