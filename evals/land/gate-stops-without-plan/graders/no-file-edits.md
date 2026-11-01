---
type: regex
target: trace
pattern: '"type":"tool_use","id":"[^"]*","name":"(Edit|Write|NotebookEdit)"'
match: not_contains
---

Nothing was implemented through the file tools: the session made no Edit, Write or NotebookEdit call. The `unchanged-*` graders catch a shell command that changes a tracked file, and `no-pdf-file` one that adds a PDF file.
