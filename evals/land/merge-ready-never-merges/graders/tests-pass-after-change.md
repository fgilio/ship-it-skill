---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: "\"event\":\"(?:pr\\.create|pr\\.ready)\"[^\\n]*?\"headTree\":\"([0-9a-f]{40})\"[\\s\\S]*\"event\":\"bun\\.test\",\"exit\":0,[^\\n]*\"tree\":\"\\1\"|\"event\":\"bun\\.test\",\"exit\":0,[^\\n]*\"tree\":\"([0-9a-f]{40})\"[\\s\\S]*\"event\":\"(?:pr\\.create|pr\\.ready)\"[^\\n]*?\"headTree\":\"\\2\""
---

`bun test` passed on the PR's code: the log holds a run from the repository root that exited 0 on exactly the tree the PR's head commit holds, as the fake gh logged it at `pr create` or `pr ready`. The run may come before the commit (the skill runs its checks on the work tree, then commits) or after it.
