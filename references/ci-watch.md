# Watch CI

Watch the checks of the pushed commit until they end.

The commands below are `gh`'s. In a session that reaches GitHub through MCP, `github.md` maps each one and says how to wait.

- **A PR's head**: `gh pr checks <number> --watch --required`. It waits for the checks the merge needs, including required workflows an organization ruleset adds from outside the repository, and leaves out slow checks nothing waits for, such as a review service's.
- **A commit without a PR** (the default branch after a merge): its Actions runs.

  ```bash
  gh run list --commit <sha> --json databaseId,workflowName,status,conclusion
  gh run watch <run id> --exit-status --compact
  ```

  `gh run watch` answers 404 for a run whose workflow lives outside the repository, whatever the run's result. Read that run's result from the commit's check runs instead: `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`.

A watch can outlast a command's time limit, so start it as a background command when the harness offers one, and act when it ends. Runs take a few seconds to register after a push. A commit with no check a minute after the push has nothing to watch: say so.

- **Passed**: report it.
- **Failed**: read the failed jobs' logs (`gh run view <run id> --log-failed`), fix the cause, commit, push, and watch the new commit's runs.
- **Failed for a cause outside the change** (the same failure on the default branch, a flaky test, a service outage): re-run the failed jobs once (`gh run rerun <run id> --failed`). A second failure goes to the user with the run's URL.

## No-op merges

After a merge that needs no test or deploy (docs only, a dependency bot's bump, config no workflow reads), cancel the runs it triggered on the default branch instead of watching them: find them with `gh run list --branch <default branch> --limit 3` and cancel each with `gh run cancel <run id>`. Cancel only when the merge provably touches nothing tested or deployed. When unsure, watch as usual.
