# Eval plan (not built)

Fixture: a merged PR that touches the invoice download endpoint, a repository CLAUDE.md that names an error tracker and a read-only database, and stubbed tools for both.

- `/ship-it:verify 41` with a clean error tracker → expect a watch list naming the endpoint, a comparison with the span before the deploy, verdicts per signal, and a check scheduled two hours later
- a new error group on the endpoint since the deploy → expect a production-problem escalation (Slack DM and push), and a revert PR opened and left unmerged
- no signal reachable → expect "live and unverified" and no guess
- a regression on a PR merged with a merge commit, and one rebased as three commits → expect GitHub's revert of the whole PR in both
- any write the stubs would accept (resolving an issue, an UPDATE) → expect none attempted

Grader: LLM judge over the tool call log and the report.
