---
type: regex
target: trace
pattern: '"type":"tool_use","id":"[^"]*","name":"(Edit|Write|NotebookEdit)"'
match: not_contains
---

Nothing was implemented through the file tools: the session made no Edit, Write or NotebookEdit call. `cli-unchanged` and `no-pdf-format` catch a shell command that rewrites a source file.
