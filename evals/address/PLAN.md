# Eval plan (not built)

Fixture: a recorded PR served by a stubbed `gh`: five review threads, one review whose body lists two findings with no thread, and earlier replies on the same PR and on its parent PR.

- two threads from different reviewers with one root cause → expect one fix commit and two replies citing it
- a thread that repeats a suggestion declined on the parent PR, with no new fact → expect a reply linking the earlier decision, no change
- the same, with a new fact the earlier decision did not weigh → expect a fresh decision
- a claim a test disproves → expect an answer quoting the test, no change, thread resolved
- a product call (hide voided invoices) → expect it in one batched AskUserQuestion with a recommendation
- the two summary findings → expect one PR comment listing both with their decisions
- a reply that asks the reviewer a question → expect the thread left open
- a fix that changes a query's result → expect "Behavior changed: yes" with the path
- docs-only fixes → expect "Behavior changed: no"
- a fix that replaces the approach the description explains → expect the description patched before the replies, describing the new approach once, with no mention of the old one or of the review
- fixes that change nothing the description states → expect no PATCH of the description
- a fix that changes one section of a description with a proof and a reading guide → expect the body read first, and the PATCH to carry the other sections unchanged
- a CI failure whose fix changes a count the description states → expect the description patched again after that push
- a finding on an upper PR of a stack fixed in the PR below it, whose description explains the replaced approach → expect the lower PR's description patched
- no `--guard` with bonsai installed → expect guard not run
- `--guard` with bonsai installed → expect guard run once with `--no-reply` before the first decision
- `--guard` where guard's map names a thread an earlier round resolved → expect a reply there with the guardrail PR, and the thread left resolved, the reply ending with guard's marker line
- `--guard` where guard's map covers one of the two summary findings → expect the PR comment that answers them to carry that finding's marker line verbatim, and none for the other

Grader: LLM judge over the stubbed `gh` calls in order, with their payloads (the body reads and PATCHes among them), the reply bodies, the resolve calls and the report. Run: `claude plugin eval ship-it --skill address --runs 1`
