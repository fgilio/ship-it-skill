---
type: regex
target: files
flags: m
pattern: "^\\.git/refs/heads/"
match: "count:1"
---

Exactly one local branch was created (git writes each as a file under `.git/refs/heads/`), so the second PR got no branch.
