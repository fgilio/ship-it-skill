---
name: pr
description: >
  Open a pull request for the current branch: commit, push, write the title and description the repository's template asks for, and watch CI. Use when a branch is ready for review.
user-invocable: true
disable-model-invocation: true
argument-hint: "[--base <branch>] [--draft]"
---

# Open a pull request

GitHub calls below use `gh`. When `gh api repos/{owner}/{repo}` fails (no `gh`, logged out, or no access to this repository), read `${CLAUDE_SKILL_DIR}/../../references/github.md` before the next GitHub call.

1. **Commit and push.** Follow `${CLAUDE_SKILL_DIR}/../../references/commit-push.md`.
2. **Find an open PR.** When the branch already has one (`gh api 'repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open'`), bring its description up to date with the branch (`gh api -X PATCH 'repos/{owner}/{repo}/pulls/<number>' -F body=@<file>`), report its URL, and go to step 5.
3. **Write the title and description.** Use the `pr-guidelines` skill when the session has it, and the repository's PR template (`.github/pull_request_template.md`, or a file under `.github/PULL_REQUEST_TEMPLATE/`) when it has one. Describe the change in its final shape: what it does, why, and what it leaves out. When the session proved the change, the description carries the proof and the reading guide, as `${CLAUDE_SKILL_DIR}/../../references/proof.md` prescribes.
4. **Create the PR.** Write the body to a file and run `gh api 'repos/{owner}/{repo}/pulls' -F head='{branch}' -f base=<base> -f title='<title>' -F body=@<file> --jq .html_url`, adding `-F draft=true` when `$ARGUMENTS` has `--draft`. The base is the `--base` argument when given, and the repository's default branch otherwise (`gh api 'repos/{owner}/{repo}' --jq .default_branch`).
5. **Watch CI.** Follow `${CLAUDE_SKILL_DIR}/../../references/ci-watch.md` for the PR's head commit.

Report the PR's URL and its CI result.
