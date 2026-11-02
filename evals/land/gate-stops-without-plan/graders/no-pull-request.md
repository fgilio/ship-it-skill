---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: '"event":"pr\.create"'
match: not_contains
---

The fake gh's call log holds no pull request creation.
