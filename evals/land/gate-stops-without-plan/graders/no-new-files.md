---
type: regex
target: files
flags: m
pattern: "^(?!\\.git/).+"
match: not_contains
---

The session created no file outside `.git/`: no source, test, note or script in the workspace. Git's own files under `.git/` (a fetch, a lock) do not count, and `no-branch` and `no-commit` read those. The run file lives under `~/.claude`, outside the workspace.
