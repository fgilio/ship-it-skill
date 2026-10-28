# Eval plan (not built)

Fixture: a branch with two commits, a `.github/pull_request_template.md` with a Testing section, and a stubbed `gh`. The session holds a proof test matrix from earlier turns.

- `/ship-it:pr` → expect one PR created with `gh api 'repos/{owner}/{repo}/pulls'` against the default branch, a body that follows the template, the proof and the reading guide inside the Testing section, and a CI watch
- the branch already has an open PR → expect its description updated, no second PR
- `/ship-it:pr --base invoice-pdf --draft` → expect `base=invoice-pdf` and `draft=true` in the create call

Grader: LLM judge over the created PR body and the `gh` call log.
