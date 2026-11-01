---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: '"event":"pr\.ready","number":1,"ok":true'
---

The pull request left draft (`gh pr ready`, or the GraphQL mutation) after CI passed.
