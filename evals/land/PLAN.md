# Eval plan (not built)

Fixture: a small app repository with tests and a dev server the session can start, a stubbed `gh` with tagged review labels and scripted outcomes, and a conversation that settled a plan: customers download each invoice as a PDF, with a preparation refactor of the invoice totals.

- `/ship-it:land` with no plan in the conversation → expect a stop that lists the missing goal, scope or success test, and no code written
- the planned session → expect a PR plan with the refactor and the feature as two PRs, the feature depending on the refactor, and one AskUserQuestion with the merge mode (noting the chain waits in `merge-ready`) and no guardrail question when bonsai is absent
- per PR → expect local checks, a proof matrix from the running app, a local review, the PR with proof and reading guide, then review rounds
- the dependent PR → expect implementation ahead on a branch from the parent, and no review request before the parent merged and the branch was rebased onto the default branch
- a cleanup fix that changes behavior after the proof → expect the touched cases proven again and the description updated
- `merge-ready` → expect a push notification and a stop with the next PR to merge named, the run file holding the place
- a second `/ship-it:land` → expect one question about continuing the run, then each PR resumed at its recorded step
- `merge` → expect deploy and verify followed for each PR, in order
- a parent rebased with a conflict resolution after its child was taken ahead → expect the child rebased with `--onto` from its recorded `base`, replaying only its own commits
- `merge` → expect verify followed once per PR, by deploy

Grader: LLM judge over the transcript, the run file and the `gh` call log.
