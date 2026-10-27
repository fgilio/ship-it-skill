# ship-it

A Claude Code plugin that ships a change: focused commits, the push, GitHub Actions watched until green, the pull request, review rounds with a decision on every finding, and, when you ask for it, the merge, the deploy and a check of production.

| Skill | Role |
| --- | --- |
| `/ship-it:ship-it` | Commit, push and watch CI. Also the entry point to the others: `/ship-it:ship-it land` runs land. |
| `/ship-it:pr` | Open the PR with the repository's template, the proof and a reading guide |
| `/ship-it:address` | Give every review finding a decision (fix, answer or escalate), reply, and resolve |
| `/ship-it:review` | Review rounds through the labels of review services: correctness, then cleanup, then maintainability |
| `/ship-it:land` | Take a planned change from implementation to merge-ready, or to merged, deployed and verified |
| `/ship-it:deploy` | Merge, watch the deploy until it is live, and approve its manual gates |
| `/ship-it:verify` | Compare production after the deploy with production before it, now and two hours later |

## Land

Land runs only when the session already knows what to build: a plan, or a design conversation that settled the decisions. Otherwise it stops and says what is missing. Its aim is to deploy as often as possible: small PRs, each merged and deployed on its own as soon as it is ready.

```text
gate: plan in the session? ── no ──> stop, list what is missing
└─ shape: PRs, wide not deep (each merges on its own)
   └─ ask once: merge mode, guardrails
      └─ each PR, in order (one that needs its parent's code reviews after the parent merged;
         │                    one that needs its parent's evidence, such as new logs, starts after they are in)
         ├─ implement → local checks → proof → local review
         ├─ open the PR as a draft (proof + reading guide) → CI green → ready
         ├─ review rounds: correctness (twice at most) → cleanup → maintainability → closing local review
         │  (each round waits for the last one's fixes and resolved threads, not its CI)
         ├─ close: CI green, base current, every finding decided, proof current
         └─ merge mode
            ├─ merge-ready: notify, you merge
            └─ merge / auto-merge: deploy → verify
```

A PR that reaches you carries a proof (what ran, and the evidence) and a reading guide (the files that bear load, and why), so the merge takes a short read.

## Review services

The review skill works with any review service that follows one protocol, and names none:

- The service offers each review as a repository label, `<service>-review:<kind>`, and starts that review on the PR's head when the label is added.
- The label's description tags the review's focus: `[correctness]`, `[cleanup]` or `[maintainability]`. Untagged labels stay out of the rounds.
- The answer is a PR review whose body ends with `<!-- <service>-review kind=<kind> sha=<head sha> -->`, or a refusal comment that carries `<!-- <service>-review-refused -->` and names the label.
- While the review runs, a check run named after the label shows on the head.

`skills/review/scripts/` holds the two scripts that speak it: one lists the tagged labels, the other requests reviews and waits for each answer.

## Merge modes

`merge-ready` (the default) stops with every PR ready and you notified. `merge` merges each ready PR, then deploys and verifies it. `auto-merge` turns on GitHub's auto-merge instead. Picking either of the last two is your permission to merge and to approve the deploy's manual gates.

## Escalation

The channel follows how much a question blocks. A question that can wait is saved and asked with the others at the next natural stop. A blocked run sends a push notification. A production problem after a deploy sends a Slack DM and a push notification at once.

## Guardrails

With [bonsai](https://github.com/publicala/claude-plugins/tree/main/plugins/bonsai) installed, `address --guard` (or guardrails turned on in land) hands each review round's findings to `/bonsai:guard`, which turns the findings a check could have caught into one guardrail PR each.

## Requirements

- The GitHub CLI (`gh`), logged in as you: review services refuse labels a bot adds.
- Node.js 22 or later, for the review scripts.
- The `code-review` skill that ships with Claude Code, for local reviews when `codex-partner` is missing.
- Used when the session has them: `codex-partner` (local reviews by a second model), `pr-guidelines` (PR descriptions), `fgilio-voice` (replies), bonsai (guardrails), a Slack tool and a push notification tool (escalation).

## Install

```
/plugin marketplace add fgilio/claude-plugins
/plugin install ship-it@fgilio
```

## Layout

- `skills/<verb>/SKILL.md`: one skill per verb
- `skills/review/scripts/`: the review service scripts
- `references/`: guidance the skills share: commit and push, watching CI, proof, merge modes, escalation
- `evals/<verb>/PLAN.md`: eval plans per skill
- `test/`: tests for the scripts, against a fake `gh` (`node --test 'test/*.test.mjs'`)

## License

MIT
