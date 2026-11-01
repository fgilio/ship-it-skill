---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: "\"event\":\"(?:pr\\.create|pr\\.ready)\"[^\\n]*?\"headSha\":\"([0-9a-f]{40})\"[\\s\\S]*\"event\":\"bun\\.test\",\"exit\":0,\"head\":\"\\1\",\"dirty\":false|\"event\":\"bun\\.test\",\"exit\":0,\"head\":\"([0-9a-f]{40})\",\"dirty\":false[\\s\\S]*\"event\":\"(?:pr\\.create|pr\\.ready)\"[^\\n]*?\"headSha\":\"\\2\""
---

`bun test` passed on the PR's code: the log holds a run from the repository root that exited 0 with a clean work tree on the commit the fake gh logged as the PR's head, at `pr create` or at `pr ready`, before or after it.
