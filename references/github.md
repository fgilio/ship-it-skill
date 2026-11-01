# GitHub through MCP

Read this when `gh api repos/{owner}/{repo}` fails. ship-it then reaches GitHub through the GitHub MCP server's tools, once the session checks three things:

- It has them (`mcp__github__*`, or the same tool names under the prefix of the session's GitHub server). Deferred tools load with ToolSearch.
- `get_me` answers with the user's login, since review services refuse labels a bot adds.
- A skill that watches CI or a deploy also has the Actions tools (`actions_list`, `actions_get`, `get_job_logs`, `actions_run_trigger`), which the server leaves out unless its `actions` toolset is on.

When a check fails, stop before the first write and say what would fix it: `gh auth login`, or connecting the GitHub MCP server with the tools it lacks.

`<owner>` and `<repo>` are the last two parts of `git remote get-url origin` split on `/` and `:`, without `.git`. That covers an SSH remote (`git@github.com:<owner>/<repo>.git`) and one behind a proxy (`http://proxy@127.0.0.1:8080/git/<owner>/<repo>`).

## Equivalents

The skills write each GitHub call as a `gh` command. With MCP, use the tool that does the same. These calls behave differently from `gh`. Tool names leave out the server prefix.

| Call | gh | MCP |
| --- | --- | --- |
| A PR's state | `gh pr view <number> --json state,isDraft,mergeStateStatus,headRefOid,labels,...` | `pull_request_read` `get`: `state`, `draft`, `merged`, `merged_at`, `mergeable_state` (`clean`, `has_hooks`, `blocked`, `dirty`, `unknown`, ...), `head.sha`, `base.ref`, and `labels` as names, left out when the PR has none. `issue_read` `get_labels` fails on a PR number |
| Review threads | `gh api graphql` with `reviewThreads` | `pull_request_read` `get_review_comments`: each thread's `id`, `is_resolved`, `is_outdated` and comments. Page with `after` |
| Reviews | `gh api 'repos/{owner}/{repo}/pulls/<number>/reviews'` | `pull_request_read` `get_reviews`, paged with `page` and `perPage` until a page comes back short |
| PR comments | `gh api 'repos/{owner}/{repo}/issues/<number>/comments'` | `pull_request_read` `get_comments`, paged the same way |
| Reply on a thread | `gh api .../pulls/<number>/comments -F in_reply_to=<databaseId>` | `add_reply_to_pull_request_comment` with the number that ends the first comment's `html_url` (`#discussion_r<number>`), since the thread lists no comment id |
| Add or remove labels | `gh api 'repos/{owner}/{repo}/issues/<number>/labels' -f 'labels[]=<label>'` / `gh api -X DELETE 'repos/{owner}/{repo}/issues/<number>/labels/<URL-encoded label>'` | `issue_write` `update` with `labels`, which replaces the whole set: send the labels just read, with the change |
| A repository's labels | `gh api 'repos/{owner}/{repo}/labels'` | `list_label` when the session has it. Otherwise `get_label` for each name, as `skills/review/without-gh.md` finds them |
| A commit's Actions runs | `gh run list --commit <sha>` | `actions_list` `list_workflow_runs` with the branch in `workflow_runs_filter`, keeping the runs whose `head_sha` is the commit |
| The merge commit | `gh api 'repos/{owner}/{repo}/pulls/<number>' --jq .merge_commit_sha` | The `sha` that `merge_pull_request` returns. When GitHub merged the PR later (auto-merge, a merge queue), the earliest commit from `list_commits` on the base branch, with `since` set to the PR's `merged_at`, whose first line ends with `(#<number>)` or starts with `Merge pull request #<number>`, as GitHub writes them. A rebase merge writes neither, so ask for the SHA instead of guessing |

## What MCP cannot do

- **The user's merge method** (`viewerDefaultMergeMethod`): read it from the base branch's history (`list_commits`). Commits titled `Merge pull request #<number>` mean `merge`, one commit per PR ending in `(#<number>)` means `squash`, and anything else means `rebase`. When the history mixes them, ask once.
- **The checks a merge requires**: MCP reads no ruleset, so it cannot say which are required. "Watching CI" below watches every check instead.
- **The scripts** (`scripts/`): they run `gh`. "Watching CI" below and `skills/review/without-gh.md` do their work by hand.

## Watching CI

`ci-watch.md` runs the watch script. With MCP, carry out the same watch by hand, and report with the script's results:

1. **The checks.** The head's check runs (`get_check_runs`, which lists a review service's checks too) and its commit statuses (`get_commit_status`, when the session has it). One entry per workflow, app and name, the newest, so jobs of one name in two workflows, and a check run and a commit status of one name, each count. A run that completed with a failing conclusion and no job (a workflow that failed to start) counts as a failed check. A check registers once its job is queued, which for a job that needs others happens when they finish: wait while anything runs, and give a quiet head 2 minutes before `none`. A head that shows nothing at all yet (no run, no check, right after a push) gets 5 minutes for the first one before `none`, and that `none` means CI never started for it.
2. **Watched.** Every check except the ones named after a review label (`<service>-review:<kind>`), so an optional check that fails holds the watch too: fix it, or report it as outside the change. A manual gate is a check run whose status is `waiting` in a run whose pending deployments list reviewers (`actions_get` `get_workflow_run` says the run is `waiting`). On a PR's watch leave the gates out and name them, since MCP reads no ruleset to say whether the merge requires one: when every other check passed and the PR's `mergeable_state` is still `blocked`, the merge waits for something the watch cannot see (the gate, or a review approval), so report the gate and ask the user which, instead of approving it. On a commit's watch a gate holds the watch. A run that waits only for an environment's timer goes on by itself: keep waiting. A run still in progress whose jobs have all completed holds a job that has yet to register: keep waiting for it too.
3. **Read** as "Waiting" says, until every watched check completed. A conclusion of `success`, `neutral` or `skipped` passes. Any other ends the watch as `failed`, with the job's URL. The head moving is `superseded`, the PR closing is `closed`, and 45 minutes is `timeout` with the pending names.
4. **Gates.** Report each gate as `ci-watch.md`'s "Manual gates" says. MCP offers no call on a run's pending deployments, so the user approves a gate, from the run's URL.

## Waiting

A `gh` watch waits as one background command. An MCP call returns at once, so a wait is a series of reads, and each one costs a turn:

- **Events first.** When the harness can subscribe the session to the PR's activity (such as `subscribe_pr_activity`), subscribe and act on each event: a review, a comment, a finished check. Keep one timer for the wait's limit.
- **Otherwise a timer, then one read.** Start a background `sleep` command, or use the harness's wake-up tool, and read once when it ends: every 60 seconds for CI and deploys, every 2 minutes for reviews.
- **Read the cheapest calls that can show a change.** For a review, the PR's head and state, the head's check runs (`get_check_runs`), and the PR's comments, since a refusal comes as a comment with no check: read the reviews when the check named after the label completes, or when an event announces a review.
- The limits stay the ones the skills set. Between reads, work on something that does not touch the PR's branch.
