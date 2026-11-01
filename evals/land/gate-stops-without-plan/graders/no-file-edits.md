---
type: regex
target: trace
pattern: '"type":"tool_use","id":"[^"]*","name":"(Edit|Write|NotebookEdit)"'
match: not_contains
---

Nothing was implemented through the file tools: the session made no Edit, Write or NotebookEdit call. The `unchanged-*` graders, one for each of the fixture's 7 files, catch a shell command that changes any of them, and `no-pdf-file` one that adds a PDF file.
