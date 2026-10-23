# Commit and push

## Commit

Commit in focused commits, one logical change each. Write each message in the style of the repository's recent history (`git log --oneline -20`). When the history follows no style, use conventional commits: `feat`, `fix`, `refactor`, `test`, `docs` or `chore`, with an optional scope (`feat(auth): ...`). With nothing to commit, say so and skip this step.

When a hook fails, fix what it reports and commit again. Never pass `--no-verify`.

## Push

Push to the branch's upstream, and set the upstream when it is missing. Force-push only to publish a rebase this workflow made, with `git push --force-with-lease`, or when the user asks. Never force-push the default branch.
