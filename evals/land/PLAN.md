# Eval plan (not built)

Fixture: a small app repository with tests and a dev server the session can start, a stubbed `gh` with tagged review labels and scripted outcomes, and a conversation that settled a plan: customers download each invoice as a PDF, with a preparation refactor of the invoice totals.

- `/ship-it:land` with no plan in the conversation → expect a stop that lists the missing goal, scope or success test, and no code written
- `use /ship-it:land` inside a message, or `/ship-it:land` sent while the session works → expect land loaded through the Skill tool with no merge mode passed, and the merge mode asked
- "ship it" in the planned session, with no skill named → expect land not loaded
- the planned session → expect a PR plan with the refactor and the feature as two PRs, the feature depending on the refactor, and one AskUserQuestion with the merge mode (noting the chain waits in `merge-ready`) and no guardrail question when bonsai is absent, and with bonsai a guardrail question that recommends `end`
- per PR → expect local checks, a proof matrix from the running app, a local review, the PR opened as a draft with proof and reading guide, CI fixed until green, `gh pr ready`, the head watched once more, then review rounds
- a repository whose PRs each meet a staging preview gate after CI → expect one question at the first gate for the whole run, `gates` recorded in the run file, every later gate following it with no second question, and no round held by a gate
- `/ship-it:land --approve-gates` → expect `gates: approve` recorded and no gate question
- the dependent PR → expect implementation ahead on a branch from the parent, and no review request before the parent merged and the branch was rebased onto the default branch
- a cleanup fix that changes behavior after the proof → expect the touched cases proven again and the description updated
- `merge-ready` → expect a push notification and a stop with the next PR to merge named, the run file holding the place
- a second `/ship-it:land` → expect one question about continuing the run, then each PR resumed at its recorded step
- `merge` → expect deploy and verify followed for each PR, in order
- a parent rebased with a conflict resolution after its child was taken ahead → expect the child rebased with `--onto` from its recorded `base`, replaying only its own commits
- `merge` → expect verify followed once per PR, by deploy
- guardrails `end` with bonsai installed → expect no guard during the rounds, then one `bonsai:guard` pass with every reviewed PR of the run and no `--no-reply`, after the last PR is done, and `guard.status` set to `done`
- guardrails `end` in `merge-ready` with a chain → expect the run to stop for the user's merge with `guard.status` still `pending`, and guard to run only after the last link is done
- guardrails `rounds` → expect `--guard` passed to each review round, and no pass at the end
- a second `/ship-it:land` on a run whose PRs are all done and whose guard is `pending` → expect the continue question, then the guard pass alone
- guardrails `end` with a blocked PR and its dependent child → expect guard to run once the rest stopped, `guard.prs` without them when they have no findings, and a later continued run that finishes them to run guard over those two alone
- guard holding a sixth candidate for a later decision round → expect `guard.status` `waiting`, and `done` only after that round
- a run file from before `guard.when`, with `"guard": true` → expect it continued as `rounds`
- a plan that logs how invoices are downloaded before changing the download → expect the logging PR shipped alone first, the change started only after the logs are in, and the plan revisited with what they show

Grader: LLM judge over the transcript, the run file and the `gh` call log.
