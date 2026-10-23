# Watch CI

Watch the GitHub Actions runs of the pushed commit until they end:

```bash
gh run list --commit <sha> --json databaseId,workflowName,status,conclusion
gh run watch <run id> --exit-status --compact
```

A run can outlast a command's time limit, so start the watch as a background command when the harness offers one, and act when it ends. Runs take a few seconds to register after a push. A commit with no run a minute after the push has nothing to watch: say so.

- **Passed**: report it.
- **Failed**: read the failed jobs' logs (`gh run view <run id> --log-failed`), fix the cause, commit, push, and watch the new commit's runs.
- **Failed for a cause outside the change** (the same failure on the default branch, a flaky test, a service outage): re-run the failed jobs once (`gh run rerun <run id> --failed`). A second failure goes to the user with the run's URL.

## No-op merges

After a merge that needs no test or deploy (docs only, a dependency bot's bump, config no workflow reads), cancel the runs it triggered on the default branch instead of watching them: find them with `gh run list --branch <default branch> --limit 3` and cancel each with `gh run cancel <run id>`. Cancel only when the merge provably touches nothing tested or deployed. When unsure, watch as usual.
