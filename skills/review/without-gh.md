# Review rounds without gh

With the GitHub MCP tools (`${CLAUDE_SKILL_DIR}/../../references/github.md`), carry out the scripts' protocol by hand, so the statuses and steps in `SKILL.md` stay the same:

1. **The labels.** Stercorario's list when the session has its tool (`SKILL.md`, "Review services"), where a label `get_label` does not find is `missing`, with no request. Otherwise `list_label` when the session has it. Otherwise the labels the repository's CLAUDE.md, AGENTS.md or README, or the user, names. Read each of these with `get_label` for its description, and keep the ones the list script would print, in its order, with `[default]` as the `default` boolean. Choose one label per round by step 2 of `SKILL.md`. A label `$ARGUMENTS` names is kept whatever its tag, as step 2 of `SKILL.md` says. Never search for more: MCP cannot list a repository's labels, a service takes its label off the PR once it answers, and a service's card or comment on a PR names that service's labels only. When `list_label` or those names give no tagged label and `$ARGUMENTS` names none, say the session cannot list the repository's labels, and ask the user once: name the labels, or go on without review rounds.
2. **Request.** Read the PR (`pull_request_read` `get`): it is open, and note its head and labels. When the chosen label's review already ends with this head's marker, it is `posted`, with no request. Otherwise note the ids of the PR's comments and of the head's check runs named after that label (`pull_request_read` `get_check_runs`, which lists a review service's checks too, unlike the Actions runs), then add that label in one `issue_write`. A label still on the PR comes off in a write of its own first, since adding it again asks for nothing. Note the time.
3. **Wait** as `github.md` says, and on each read settle the pending label:
   - The PR closed: `closed`. The head moved: `superseded`.
   - A review whose body ends with the marker `<!-- <service>-review kind=<kind> sha=<head> ... -->`: `posted`. A marker quoted inside the text does not count.
   - A comment that is new since step 2, carries `<!-- <service>-review-refused` and names the label on its own (`x-review:code-review:high` does not name `x-review:code-review`): `refused`, with the comment's first line as the reason.
   - A check run named after the label, new since step 2 and completed with conclusion `cancelled` or `skipped`: `cancelled` at once, with no grace wait or retry. A person stopped it on purpose. Do not request it again. Report it, and go on with the round.
   - Any other completed check run named after the label, new since step 2, with still no review two reads later: `unanswered`.
   - 30 minutes since the request: `timeout`.

   An `unanswered` or `timeout` label is requested once more, from step 2, before it settles.

4. **The outcome** has the run script's shape: `head`, `head_moved_to` from one last read of the head, and each label's status with its review URL or reason.
