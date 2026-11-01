---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
flags: i
pattern: '"event":"pr\.create","number":\d+,"draft":\w+,"head":"[^"]*pdf|"event":"pr\.create","number":\d+,"draft":\w+,"head":"[^"]*","base":"[^"]*","title":"(?:[^"\\]|\\.)*pdf'
match: not_contains
---

The pull request opened is the logging PR: no created pull request's title or branch names the PDF format. The body may mention it, as the PR that comes later.
