# Watch CI

Watch the checks of the pushed commit until they end, with the watch script:

```bash
# A PR's head
bun ${CLAUDE_SKILL_DIR}/../../scripts/ship-it-ci-watch.ts <PR number or URL>
# A commit without a PR (the default branch after a merge)
bun ${CLAUDE_SKILL_DIR}/../../scripts/ship-it-ci-watch.ts <sha>
# → {"result": "passed", "head": "<sha>", "required": [...], "failed": [...], "pending": [...], "gates": [...]}
```

The script needs `gh`. When `gh api repos/{owner}/{repo}` fails, read `github.md` and follow its "Watching CI" section instead.

It waits up to 45 minutes, so start it as a background command and act on its output when it ends. For a PR it watches the checks the merge requires, read from the base branch's rulesets (an organization's included) and its branch protection: the required status checks, pinned to their app when the rule names one, and the jobs of the required workflows. When they name none, it watches every check on the head except a review service's and the manual gates. A check registers once its job is queued, which for a job that needs others happens when they finish, so the script waits while anything runs and gives a quiet commit 2 minutes. Right after a push the head can show nothing at all for a while (no run, no check), so the script waits up to 5 minutes for the first one. For a commit it watches every check except a review service's, gates included.

| Result | Meaning | Next |
| --- | --- | --- |
| `passed` | Every watched check passed | Report it, and the `gates` it lists, as "Manual gates" says. |
| `failed` | A watched check failed; `failed` names it with its run and job | Read the failed jobs' logs (`gh run view <run id> --log-failed`), fix the cause, commit, push, and watch the new commit. For a cause outside the change (the same failure on the default branch, a flaky test, a service outage), re-run the failed jobs once (`gh run rerun <run id> --failed`) and watch again. A second failure goes to the user with the run's URL. |
| `gated` | A watched check waits for an environment's approval | "Manual gates" below. |
| `none` | No check registered within 2 minutes of the last activity, or nothing appeared on the head within 5 minutes. In the second case the script also exits 1 and says so on stderr | A PR whose `missing` names required checks waits for a check that never ran: escalate as blocked with the names, since the merge waits for them too. When nothing appeared at all, CI never started for the head: read the workflows' triggers, and escalate as blocked when the repository runs CI on this branch. Otherwise the commit has nothing to watch: say so. |
| `timeout` | Checks still ran at the limit; `pending` names them | Escalate as can wait, with their URLs. |
| `superseded` | The head moved (`head_moved_to`) | Watch the new head. |
| `closed` | The PR closed | Stop. |

## Manual gates

A job that waits for an environment's reviewers is a manual gate, never CI. The script lists every gate it meets in `gates`: the run, its environment, whether the user can approve it (`can_approve`), and the jobs that wait. The jobs behind a gate register only once it is approved, so a queued job is queued for a runner and the watch keeps it. It waits for a gate only when the merge requires it, or on a commit's watch, where the run cannot end without it. When the base branch's classic protection cannot be read (`requirements_known` is false: no admin access), the merge may require a gate the watch cannot see, so it holds for every gate and the user says whether the merge waits for it. An environment's wait timer is not a gate: the job goes on by itself, and the watch waits through it.

The report names each gate with its environment and URL, approved or not. Approving one has effects beyond CI (a deploy to that environment), so it takes the user's permission:

- The `deploy` skill's invocation, which covers the deploy's gates.
- `gates: approve` in a land run file, or `--approve-gates` passed to the skill.
- Otherwise, when `can_approve` is true, one AskUserQuestion per invocation, at the first gate met: it names the PR or commit, the gate, its environment and what approving does (the environment's URL when GitHub shows one), and offers to approve every gate this invocation meets, to leave them, or to decide each gate as it comes. The answer holds for the rest of the invocation.

To approve, run the script again with `--approve-gates` for every gate, or `--approve-gates=<environment>` for the gates the user chose (several names with commas): it approves each of those the user can approve through the run's pending deployments, marks it `approved`, and watches on. With "each gate as it comes", a gate of another environment asks again before anything approves it. A gate the user cannot approve stays listed: escalate as blocked when the result is `gated`, and name it in the report otherwise. Never look for another way through: no other account, no admin bypass, no change to the environment's rules.

## No-op merges

After a merge that needs no test or deploy (docs only, a dependency bot's bump, config no workflow reads), cancel the runs it triggered on the default branch instead of watching them: find them with `gh run list --branch <default branch> --limit 3` and cancel each with `gh run cancel <run id>`. Cancel only when the merge provably touches nothing tested or deployed. When unsure, watch as usual.
