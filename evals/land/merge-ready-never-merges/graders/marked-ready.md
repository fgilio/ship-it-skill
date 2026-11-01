---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: "\"event\":\"ci\\.checks\",\"sha\":\"([0-9a-f]{40})\"[\\s\\S]*?\"event\":\"pr\\.ready\",\"number\":1,\"headSha\":\"\\1\",\"ok\":true"
---

CI was watched before the PR left draft: the log reads the head's check runs (the CI watch script's query, which the fake answers with a passing `test`) and then marks PR 1 ready on that same commit.
