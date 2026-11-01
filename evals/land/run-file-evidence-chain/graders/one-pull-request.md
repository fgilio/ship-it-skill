---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: '"event":"pr\.create"'
match: "count:1"
---

The fake gh's call log holds exactly one pull request creation.
