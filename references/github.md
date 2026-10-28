# GitHub access

ship-it reaches GitHub through the GitHub CLI (`gh`), or through the GitHub MCP server's tools in a session where `gh` does not work. Either one must act as the user, since review services refuse labels a bot adds. Pick once per session, before the first GitHub call:

1. **gh** when `gh api repos/<owner>/<repo> --jq .full_name` prints the repository and `gh api user --jq .login` prints the user's login. Unlike `gh auth status`, the first call also fails for a token that cannot reach this repository (an organization's SSO, a token scoped to other repositories).
2. **MCP** when the session has the GitHub MCP tools (`mcp__github__*`, or the same tool names under the prefix of the session's GitHub server; load them with ToolSearch when they are deferred) and `get_me` answers with the user's login. A skill that watches CI or a deploy also needs the Actions tools (`actions_list`, `actions_get`, `get_job_logs`, `actions_run_trigger`), which the server leaves out unless its `actions` toolset is on. Without them, stop before the first write and say so.
3. **Neither**: stop and say what would fix it: `gh auth login`, or connecting the GitHub MCP server.

When both work, use gh: the review scripts and every watch run on it as background commands, which wait without spending a turn on each check.

`<owner>` and `<repo>` are the last two parts of `git remote get-url origin` split on `/` and `:`, without `.git`. That covers an SSH remote (`git@github.com:<owner>/<repo>.git`) and one behind a proxy (`http://proxy@127.0.0.1:8080/git/<owner>/<repo>`).

## Equivalents

The skills write each GitHub call as a `gh` command. With MCP, use the tool that does the same. These calls behave differently from `gh`. Tool names leave out the server prefix.

| Call | gh | MCP |
| --- | --- | --- |
| A PR's state | `gh pr view <number> --json state,isDraft,mergeStateStatus,headRefOid,labels,...` | `pull_request_read` `get`: `state`, `draft`, `merged`, `merged_at`, `mergeable_state` (`clean`, `has_hooks`, `blocked`, `dirty`, `unknown`, ...), `head.sha`, `base.ref`, and `labels` as names, left out when the PR has none. `issue_read` `get_labels` fails on a PR number |
| Review threads | `gh api graphql` with `reviewThreads` | `pull_request_read` `get_review_comments`: each thread's `id`, `is_resolved`, `is_outdated` and comments. Page with `after` |
| Reviews | `gh api repos/<owner>/<repo>/pulls/<number>/reviews` | `pull_request_read` `get_reviews`, paged with `page` and `perPage` until a page comes back short |
| PR comments | `gh api repos/<owner>/<repo>/issues/<number>/comments` | `pull_request_read` `get_comments`, paged the same way |
| Reply on a thread | `gh api .../pulls/<number>/comments -F in_reply_to=<databaseId>` | `add_reply_to_pull_request_comment` with the number that ends the first comment's `html_url` (`#discussion_r<number>`), since the thread lists no comment id |
| Add or remove labels | `gh pr edit <number> --add-label <label>` / `--remove-label <label>` | `issue_write` `update` with `labels`, which replaces the whole set: send the labels just read, with the change |
| A repository's labels | `gh api repos/<owner>/<repo>/labels` | `list_label` when the session has it. Otherwise `get_label` for each name, as the review skill's "Without gh" finds them |
| A commit's Actions runs | `gh run list --commit <sha>` | `actions_list` `list_workflow_runs` with the branch in `workflow_runs_filter`, keeping the runs whose `head_sha` is the commit |
| The merge commit | `gh pr view <number> --json mergeCommit` | The `sha` that `merge_pull_request` returns. When GitHub merged the PR later (auto-merge, a merge queue), the earliest commit from `list_commits` on the base branch, with `since` set to the PR's `merged_at`, whose first line ends with `(#<number>)` or starts with `Merge pull request #<number>`, as GitHub writes them. A rebase merge writes neither, so ask for the SHA instead of guessing |

## What MCP cannot do

- **The user's merge method** (`viewerDefaultMergeMethod`): read it from the base branch's history (`list_commits`). Commits titled `Merge pull request #<number>` mean `merge`, one commit per PR ending in `(#<number>)` means `squash`, and anything else means `rebase`. When the history mixes them, ask once.
- **Reverting a PR** (`revertPullRequest`): revert by hand, as verify does when GitHub cannot build the revert.
- **The checks a merge requires** (`gh pr checks --required`): MCP does not say which are required. Watch every check on the head except the ones named after a review label (`<service>-review:<kind>`), so an optional check that fails holds the watch too: fix it, or report it as outside the change.

## Waiting

A `gh` watch waits as one background command. An MCP call returns at once, so a wait is a series of reads, and each one costs a turn:

- **Events first.** When the harness can subscribe the session to the PR's activity (such as `subscribe_pr_activity`), subscribe and act on each event: a review, a comment, a finished check. Keep one timer for the wait's limit.
- **Otherwise a timer, then one read.** Start a background `sleep` command, or use the harness's wake-up tool, and read once when it ends: every 60 seconds for CI and deploys, every 2 minutes for reviews.
- **Read the cheapest calls that can show a change.** For a review, the PR's head and state, the head's check runs, and the PR's comments, since a refusal comes as a comment with no check: read the reviews when the check named after the label completes, or when an event announces a review.
- The limits stay the ones the skills set: 30 minutes per review request, an hour for a merge. Between reads, work on something that does not touch the PR's branch.
