---
type: regex
target: files
flags: m
pattern: "^\\.git/refs/heads/"
match: not_contains
---

No local branch was created: git writes a new branch as a file under `.git/refs/heads/`.
