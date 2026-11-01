---
type: regex
target:
  source: file
  path: .fake-bin/bun-calls.jsonl
flags: m
pattern: "^(?=[^\\n]*\"command\":\"test\")(?=[^\\n]*\"exit\":0,)(?![^\\n]*\"head\":\"65d8829715d36b6d2c16a13d4d75cde484807559\",\"dirty\":false)"
---

`bun test` passed after the change: the bun wrapper logged a run from the repository root that exited 0 on a commit other than the fixture's `main`, or with changes in the work tree.
