---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: "\"event\":\"ci\\.checks\",\"sha\":\"([0-9a-f]{40})\"[\\s\\S]*?\"event\":\"pr\\.ready\",\"number\":1,\"headSha\":\"\\1\"[^\\n]*\"ok\":true[\\s\\S]*?\"event\":\"ci\\.checks\",\"sha\":\"\\1\""
---

CI was watched around the PR leaving draft, as land's step 6 says: the log reads the head's check runs (the CI watch's query, which the fake answers with a passing `test`), then marks PR 1 ready on that same commit, then reads that commit's check runs once more, since a workflow may run only when a PR leaves draft.
