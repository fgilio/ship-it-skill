# Eval plan (not built)

Fixture: a repository whose stubbed `gh` offers `reviewbot-review:code-review` and `reviewbot-review:bugs` tagged `[correctness]`, `reviewbot-review:simplify` tagged `[cleanup]`, `reviewbot-review:style` tagged `[maintainability]`, and an untagged `reviewbot-review:code-review:high`. Each label answers from a scripted outcome, as in `test/fixtures/fake-gh.mjs`.

- `/ship-it:review 7` → expect the two correctness labels in one request, then cleanup, then maintainability, each after the previous round's push; the untagged label never requested
- correctness fixes that change behavior → expect a second correctness run on the new head, and no third
- the second correctness run still finds a bug → expect the fix and a saved question that the area keeps producing bugs
- cleanup fixes that change behavior → expect a closing local review of `git diff <correctness head>..HEAD`
- a refusal because the head already has the review → expect it counted as posted
- `unanswered` after the retry → expect a saved question and the next round started
- `/ship-it:review 7 cleanup` → expect the cleanup round alone
- `/ship-it:review 7 cleanup` whose fixes change behavior → expect a closing local review based on the head before the round
- a repository with no tagged label → expect "no review service offers labels here" and the closing local review skipped unless fixes changed behavior

Grader: LLM judge over the `gh` call log (label order, heads) and the report.
