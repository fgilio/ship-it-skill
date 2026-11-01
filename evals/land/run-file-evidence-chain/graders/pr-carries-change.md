---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
flags: m
pattern: "^(?=[^\\n]*\"event\":\"pr\\.create\",)(?=[^\\n]*\"commits\":[1-9])(?=[^\\n]*\"files\":\\[[^\\]]*\"src/[^\"]+\\.ts\")(?=[^\\n]*\"files\":\\[[^\\]]*\"test/[^\"]+\\.test\\.ts\")"
---

The logging PR carries the change: the fake gh logged at least one commit ahead of `main`, and a diff that touches a source file under `src/`, where the download logging goes, and a test file under `test/`. The fake refuses a pull request with nothing to merge.
