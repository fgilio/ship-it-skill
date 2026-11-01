# Eval plan (not built)

Fixture: a repository whose stubbed `gh` offers `reviewbot-review:code-review` and `reviewbot-review:bugs` tagged `[correctness]`, `reviewbot-review:simplify` tagged `[cleanup]`, `reviewbot-review:style` tagged `[maintainability]`, and an untagged `reviewbot-review:code-review:high`. Each label answers from a scripted outcome, as in `test/fixtures/fake-gh.ts`.

- `/ship-it:review 7` → expect the two correctness labels in one request, then cleanup, then maintainability, each after the previous round's push; the untagged label never requested
- a PR whose CI is still running → expect the first round requested only after CI is green, with no wait for an unrequested Codex review
- a round's push whose CI is still running → expect the next round requested once its threads are answered and resolved, before that CI ends
- CI failing while the cleanup round's reviews run → expect its fix pushed with the cleanup round's fixes, after the run script returns, and no review superseded
- CI failing while a cleanup review times out with its service still running → expect the held fix pushed once the run script returns `timeout`, and a saved question for the timeout
- a correctness thread whose reply asks the reviewer a question → expect the cleanup round requested only after that thread is answered and resolved
- `/ship-it:review 7 cleanup` whose test-only fix fails CI after address returns → expect the CI fix pushed and CI watched to green before the report, which names that head
- correctness fixes that change behavior → expect a second correctness run on the new head, and no third
- the second correctness run still finds a bug → expect the fix and a saved question that the area keeps producing bugs
- cleanup fixes that change behavior → expect a closing local review of `git diff <correctness head>..HEAD`
- a refusal because the head already has the review → expect it counted as posted
- `unanswered` after the retry → expect a saved question and the next round started
- `/ship-it:review 7 cleanup` → expect the cleanup round alone
- `/ship-it:review 7 cleanup` whose fixes change behavior → expect a closing local review based on the head before the round
- a session with the GitHub MCP tools and no `gh` → expect the labels found from earlier reviews' markers and `get_label`, each request one `issue_write` that keeps the PR's other labels, a label still on the PR written off before it is added again, and the outcome in the run script's shape
- a repository with no tagged label → expect "no review service offers labels here" and the closing local review skipped unless fixes changed behavior

Grader: LLM judge over the `gh` call log (label order, heads) and the report.
