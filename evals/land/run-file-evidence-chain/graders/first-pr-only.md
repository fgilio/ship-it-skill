---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
flags: i
pattern: '"event":"pr\.create"[^\n]*pdf'
match: not_contains
---

The pull request opened is the logging PR: no created pull request's title or branch names the PDF format.
