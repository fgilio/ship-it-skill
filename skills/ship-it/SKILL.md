---
name: ship-it
description: >
  Ship code: commit in focused commits, push, and watch GitHub Actions until green. Also the entry point to the rest of ship-it: open a PR, address review feedback, run review rounds, land a planned change end to end, deploy, and verify production.
user-invocable: true
disable-model-invocation: true
argument-hint: "[commit | push | monitor | pr | address | review | land | deploy | verify] [...]"
---

# Ship it

## Dispatch

Read the first word of `$ARGUMENTS`, lowercased:

| First word | Runs |
| --- | --- |
| _(none)_ | commit, push, monitor |
| `commit` | commit |
| `push` | commit, push |
| `monitor` | monitor |
| `pr`, `address`, `review`, `land`, `deploy`, `verify` | that skill, with the rest of the arguments |

For any other word, list the options above and stop.

To run another ship-it skill, read `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md` and follow it. Inside that file, `${CLAUDE_SKILL_DIR}` means `${CLAUDE_SKILL_DIR}/../<name>`, and `$ARGUMENTS` means the arguments after the first word.

## Commit and push

Follow `${CLAUDE_SKILL_DIR}/../../references/commit-push.md`.

## Monitor

Follow `${CLAUDE_SKILL_DIR}/../../references/ci-watch.md` for the branch's last pushed commit: through its open PR when it has one, and as a commit otherwise.
