---
type: regex
target:
  source: file
  path: src/invoices.ts
flags: i
pattern: "[\"'`]pdf[\"'`]"
match: not_contains
---

The PDF format was not implemented: `src/invoices.ts`, where the download formats live, holds no `pdf` string literal at the end of the run.
