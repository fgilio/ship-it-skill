---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
flags: m
pattern: "^(?=[^\\n]*\"event\":\"pr\\.create\",)(?=[^\\n]*\"commits\":[1-9])(?=[^\\n]*\"files\":\\[[^\\]]*\"src/(?:invoices|cli)\\.ts\")(?=[^\\n]*\"files\":\\[[^\\]]*\"test/[^\"]+\\.test\\.ts\")"
---

The pull request carries the change: the fake gh logged at least one commit ahead of `main`, and a diff that touches `src/invoices.ts` or `src/cli.ts`, where the item count lives, and a test file under `test/`. The fake refuses a pull request with nothing to merge.
