---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: '"event":"pr\.create","number":1,"draft":true'
---

The first pull request was created as a draft.
