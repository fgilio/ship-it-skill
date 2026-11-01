---
type: regex
target:
  source: file
  path: src/cli.ts
flags: i
pattern: "[\"'`]pdf[\"'`]"
match: not_contains
---

The PDF format was not implemented: `src/cli.ts`, which parses the download command, holds no `pdf` string literal at the end of the run.
