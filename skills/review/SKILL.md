---
name: review
description: >
  Run review rounds on an open pull request: request the reviews the repository's review services offer through labels, wait for them, and address every finding, one focus per round (correctness, then cleanup, then maintainability). Use when a PR is ready for automated review, or to run one round or one label again.
user-invocable: true
disable-model-invocation: true
argument-hint: "[<PR number or URL>] [correctness | cleanup | maintainability | <label>...] [--guard]"
---

# Review rounds

A round runs every review of one focus on the same head, in parallel, and ends when every finding has a decision and the fixes are pushed: **one focus per round**. Rounds run in this order:

1. **Correctness**: bugs, races, security, broken contracts.
2. **Cleanup**: duplication, dead code, simpler ways to do the same thing.
3. **Maintainability**: naming, structure, conventions.

Fixes made after the last correctness run can change behavior too, so a closing local review checks them.

## Review services

A review service offers its reviews as repository labels named `<service>-review:<kind>`, and tags each label's description with its focus: `[correctness]`, `[cleanup]` or `[maintainability]`. Adding a label to a PR asks for that review of the head commit. The service answers with a PR review whose body ends with `<!-- <service>-review kind=<kind> sha=<head sha> ... -->`, or with a refusal comment that carries `<!-- <service>-review-refused ... -->` and names the label. It also shows a check run named after the label while the review runs. A service reviews a head once per kind, so a round asks again only after a push. Untagged labels stay out of the rounds.

Two scripts carry the protocol:

```bash
# The tagged review labels, by focus
${CLAUDE_SKILL_DIR}/scripts/ship-it-review-list.mjs
# → [{"label": "<service>-review:<kind>", "service": "...", "kind": "...", "focus": "correctness"}, ...]

# Ask for reviews on the PR head and wait for every answer
${CLAUDE_SKILL_DIR}/scripts/ship-it-review-run.mjs <PR> <label>...
# → {"head": "<sha>", "reviews": [{"label": "...", "status": "posted", "review_url": "...", ...}]}
```

The run script adds the labels with the session's GitHub credentials, which must be the user's: services refuse labels a bot adds. It waits up to 30 minutes per request and asks again once when a request ends without a review, so start it as a background command and act on its output when it ends. While it waits, work on something that does not touch this PR's branch.

| Status | Meaning | Next |
| --- | --- | --- |
| `posted` | The review is on the PR | Address it |
| `refused` | The service said why it did not start | A refusal because the head already has that review counts as posted, and address finds that review on the PR. Any other reason: escalate as can wait. |
| `unanswered`, `timeout` | No review after the retry | Escalate as can wait, and go on with the next round |
| `superseded` | The head moved while the review ran | Ask again for the new head, once |
| `closed` | The PR closed | Stop |

When the output's `head_moved_to` is set, someone pushed during the wait: the posted reviews cover `head`, and a round started after the push asks for the new head.

## Steps

1. **The PR.** The PR in `$ARGUMENTS`, or the open PR of the current branch. Its branch has no uncommitted or unpushed changes, and CI is green on its head: the first round waits for that, fixing failures until it is. A review service's own review never holds it.
2. **The labels.** Run the list script. A focus name in `$ARGUMENTS` limits the run to that round. Labels in `$ARGUMENTS` run as one round of their own. When the repository offers no tagged label, say so and go to step 5.
3. **Each round, in order.** For a focus with no label, skip the round and say so.
   1. Run the run script with every label of the round.
   2. Address the round: follow `${CLAUDE_SKILL_DIR}/../address/SKILL.md` for this PR, passing `--guard` when `$ARGUMENTS` has it. It covers every unresolved finding on the PR, including reviews nobody requested, such as a bot that reviews every new PR. The artifact is its report, with the behavior line.
   3. The round ends when every finding has a decision, the fixes are pushed, and every thread has its reply and is resolved, or left open for the reason address gives. The next round's request waits for that, and not for the push's CI: watch it in the background. When CI fails while a round's reviews run, fix it, and push the fix with that round's fixes once its reviews are posted, so a push never supersedes a review in flight. When no review runs, push the fix at once.
4. **Correctness twice at most.** When the correctness round's fixes changed behavior, run the correctness round once more on the new head, with every label of the round, including any that went unanswered. The cap is two correctness runs. When the second still finds bugs, fix them, address the round, and escalate as can wait: this area keeps producing bugs, and the user decides whether it needs another look or a different design. Then go on with the cleanup round.
5. **Closing local review.** When any fix made after the head that the last correctness run reviewed changed behavior (a fix of that run, or of the cleanup or maintainability round), review the changes since that head. The run script's output names it as `head`. When no correctness round ran in this invocation, the base is the PR's head before the first round. Use the `codex-partner` skill's review mode when the session has it, since a second model reads the code independently, and the `code-review` skill otherwise. Ask it to review `git diff <that head>..HEAD` for bugs those fixes introduced. Fix every P0 and P1, and each P2 that holds up against the code, then run the local checks and push. Two passes at most, then escalate as can wait.

## Report

Per round: the labels requested, each outcome with its review URL, the findings fixed, answered and escalated, and whether behavior changed. Then the closing review's result, the final head, and every escalation still waiting for the user.
