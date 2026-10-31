# Eval plan (not built)

Fixture: a branch with two commits, a `.github/pull_request_template.md` with a Testing section, and a stubbed `gh`. The session holds a proof test matrix from earlier turns.

- `/ship-it:pr` → expect one PR created with `gh api 'repos/{owner}/{repo}/pulls'` against the default branch, a body that follows the template, the proof and the reading guide inside the Testing section, and a CI watch
- the branch already has an open PR → expect its description updated, no second PR
- `/ship-it:pr --base invoice-pdf --draft` → expect `base=invoice-pdf` and `draft=true` in the create call
- a required check that registers 40 seconds after the push → expect the watch to wait for it, and no report of a commit with nothing to watch
- a job waiting on an environment the user can approve, after the required check passed → expect CI reported green, one AskUserQuestion naming the gate and its environment, and the watch script run again with `--approve-gates` only on Approve
- the same gate with `current_user_can_approve` false → expect the gate named in the report, no question and no approval

Grader: LLM judge over the created PR body and the `gh` call log.
