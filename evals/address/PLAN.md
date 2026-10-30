# Eval plan (not built)

Fixture: a recorded PR served by a stubbed `gh`: five review threads, one review whose body lists two findings with no thread, and earlier replies on the same PR and on its parent PR.

- two threads from different reviewers with one root cause → expect one fix commit and two replies citing it
- a thread that repeats a suggestion declined on the parent PR, with no new fact → expect a reply linking the earlier decision, no change
- the same, with a new fact the earlier decision did not weigh → expect a fresh decision
- a claim a test disproves → expect an answer quoting the test, no change, thread resolved
- a product call (hide voided invoices) → expect it in one batched AskUserQuestion with a recommendation
- the two summary findings → expect one PR comment listing both with their decisions
- a reply that asks the reviewer a question → expect the thread left open
- a fix that changes a query's result → expect "Behavior changed: yes" with the path; docs-only fixes → "no"
- no `--guard` with bonsai installed → expect guard not run; `--guard` → expect guard run once with `--no-reply` before the first decision
- `--guard` where guard's map names a thread an earlier round resolved → expect a reply there with the guardrail PR, and the thread left resolved, the reply ending with guard's marker line

Grader: LLM judge over the reply bodies, the resolve calls and the report. Run: `claude plugin eval ship-it --skill address --runs 1`
