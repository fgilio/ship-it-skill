# Eval plan (not built)

Fixture: a repository whose stubbed `gh` offers `reviewbot-review:code-review` and `reviewbot-review:bugs` tagged `[correctness]`, `reviewbot-review:simplify` tagged `[cleanup]`, `reviewbot-review:style` tagged `[maintainability]`, and an untagged `reviewbot-review:code-review:high`. Each label answers from a scripted outcome, as in `test/fixtures/fake-gh.ts`.

- `/ship-it:review 7` → expect the two correctness labels in one request, then cleanup, then maintainability, each after the previous round's push. The untagged label is never requested
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
- a session with the GitHub MCP tools and no `gh` → expect the labels the repository's AGENTS.md names read with `get_label`, each request one `issue_write` that keeps the PR's other labels, a label still on the PR written off before it is added again, and the outcome in the run script's shape
- a session with the GitHub MCP tools and no `gh`, no label named in the repository's docs, and another service's untagged label offered on the PR → expect no search through PRs or reviews, one question (name the labels, or go on without review rounds), and the untagged label never requested
- a session with a stubbed `list_reviews` that answers the fixture's labels, the untagged one with no `focus` → expect no list script, the rounds in the same order, and the label with no `focus` never requested
- a stubbed `list_reviews` that names a label the repository lacks → expect it reported `missing` and said, and the round run with the rest
- a stubbed `list_reviews` whose `github_login` is the `gh` login in another case → expect stercorario's list
- a stubbed `list_reviews` whose `github_login` is not the `gh` login, or whose call fails → expect that said, and the list script's labels
- a stubbed `list_reviews` that answers no review, with `repository_known` false → expect the list script's labels
- a stubbed `list_reviews` that answers no review, with `repository_known` true → expect the reason said, no list script and no round
- a stubbed `list_reviews` → expect the call to carry the PR's number as `pull_request`
- a stubbed `list_reviews` whose `unavailable` names one correctness label as `already_reviewed`, with another correctness label in `reviews` → expect a request for the other label only, the first one's `review_url` in the report as posted, and both reviews' findings addressed in the correctness round
- `/ship-it:review 7 cleanup` with a stubbed `list_reviews` whose `unavailable` names the cleanup label and whose `reviews` holds a correctness label → expect no request, and the cleanup review's findings addressed
- a stubbed `list_reviews` whose `unavailable` names the only correctness label, with an open finding, and whose `reviews` holds a cleanup label → expect the finding addressed before the cleanup request, and a correctness run on the new head when its fix changes behavior
- a stubbed `list_reviews` whose `unavailable` names a cleanup label whose fix changes behavior → expect no correctness run for it, and the closing local review
- a stubbed `list_reviews` whose `unavailable` entry has no `focus` → expect it counted in the correctness round
- a stubbed `list_reviews` with an empty `reviews`, no `reason` and every label in `unavailable` → expect each round run with no request, in focus order
- a stubbed `list_reviews` whose `head_sha` is not the PR's head → expect nothing counted as posted, and the call made again
- correctness fixes pushed after a stubbed `list_reviews` answered → expect a second call before the next round, and the labels of that answer requested
- a repository with no tagged label → expect "no review service offers labels here" and the closing local review skipped unless fixes changed behavior

Grader: LLM judge over the `gh` call log (label order, heads) and the report.
