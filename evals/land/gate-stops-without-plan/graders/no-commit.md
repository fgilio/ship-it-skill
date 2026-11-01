---
type: regex
target: files
flags: m
pattern: "^\\.git/objects/"
match: not_contains
---

No commit was made: a commit, or a file staged for one, adds objects under `.git/objects/`.
