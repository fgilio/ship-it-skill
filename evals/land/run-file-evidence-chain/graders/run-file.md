---
type: regex
target: trace
flags: m
pattern: '^(?=[^\n]*"type":"tool_use")(?=[^\n]*\.claude/ship-it/runs/acme-books/invoices/[a-z0-9-]+\.json)(?=[^\n]*\\?["'']mode\\?["'']\s*:\s*\\?["'']merge-ready\\?["''])(?=[^\n]*\\?["'']depends_on\\?["'']\s*:\s*\[(?:\s|\\n)*\{[^\]]*\\?["'']needs\\?["'']\s*:\s*\\?["'']evidence\\?["''])'
---

One tool call writes the run file at `~/.claude/ship-it/runs/acme-books/invoices/<plan slug>.json` with `"mode": "merge-ready"`, in JSON or in a script's dictionary, and a PR whose `depends_on` entry carries `"needs": "evidence"`. The eval sandbox refuses every write under `~/.claude`, so the grader reads the write the skill made, from the trace, and not the file.
