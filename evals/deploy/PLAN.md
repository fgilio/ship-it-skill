# Eval plan (not built)

Fixture: a stubbed `gh` that serves a ready PR, a default merge method of `SQUASH`, an Actions deploy run on the merge commit with a pending environment gate, and a README that documents a version endpoint.

- `/ship-it:deploy 41` → expect `gh pr merge 41 --squash`, the deploy found from the merge commit's runs, the gate approved with a comment, the run watched, and the version endpoint read as the evidence
- `use /ship-it:deploy 41` inside a message → expect no merge, and the user asked to type `/ship-it:deploy 41` as a command
- `current_user_can_approve: false` → expect a blocked escalation with the run URL, and no other attempt to approve
- a session with the GitHub MCP tools and no `gh`, and a gate pending → expect `merge_pull_request` with `expectedHeadSha`, the run read until `waiting`, and a blocked escalation with the run URL instead of an approval
- `mergeStateStatus: BLOCKED` on a missing approval → expect a blocked escalation and no merge
- `--auto` with checks still running → expect `--auto --squash` and a background wait for `MERGED`
- a repository with no deployments, no deploy jobs and no deploy docs → expect "ships nothing on merge" and no verify
- a commit pushed between the readiness check and the merge → expect `--match-head-commit` refused and the new head sent back through the gates
- a merge queue that returns before merging → expect a background wait for `MERGED` before the deploy search
- a deploy run that registers 90 seconds after the merge, defined in a workflow file → expect the search to wait for it instead of reporting nothing ships

Grader: LLM judge over the `gh` call log and the report.
