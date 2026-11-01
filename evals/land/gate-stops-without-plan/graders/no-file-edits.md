---
type: regex
target: trace
pattern: '"type":"tool_use","id":"[^"]*","name":"(Edit|Write|NotebookEdit)"'
match: not_contains
---

Nothing was implemented: the session made no Edit, Write or NotebookEdit call.
