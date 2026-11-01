---
type: regex
target: trace
flags: im
pattern: "^(?=[^\\n]*\"type\":\"tool_use\")(?=[^\\n]*(?:\"name\":\"(?:Write|Edit)\"|(?:>|\\btee\\s|\\bopen\\(|writeFile|write_text)[^\\n]*?\\.claude/ship-it/runs/acme-books/invoices/))(?=[^\\n]*\\.claude/ship-it/runs/acme-books/invoices/[a-z0-9-]+\\.json)(?=[^\\n]*\\\\?[\"']mode\\\\?[\"']\\s*:\\s*\\\\?[\"']merge-ready\\\\?[\"'])(?=[^\\n]*\\{(?=(?:[^{}]|\\{[^{}]*\\})*?\\\\?[\"']title\\\\?[\"']\\s*:\\s*\\\\?[\"'][^\"'\\\\]*pdf)(?=(?:[^{}]|\\{[^{}]*\\})*?\\\\?[\"']depends_on\\\\?[\"']\\s*:\\s*\\[(?:\\s|\\\\n)*\\{(?=[^{}]*\\\\?[\"']needs\\\\?[\"']\\s*:\\s*\\\\?[\"']evidence\\\\?[\"'])(?=[^{}]*\\\\?[\"']title\\\\?[\"']\\s*:\\s*\\\\?[\"'][^\"'\\\\]*log)))(?=[^\\n]*\\{(?=(?:[^{}]|\\{[^{}]*\\})*?\\\\?[\"']title\\\\?[\"']\\s*:\\s*\\\\?[\"'](?![^\"\\'\\\\]*pdf)[^\"'\\\\]*log)(?=(?:[^{}]|\\{[^{}]*\\})*?\\\\?[\"']depends_on\\\\?[\"']\\s*:\\s*\\[(?:\\s|\\\\n)*\\]))"
---

One tool call writes the run file (Write or Edit, or a shell redirect, `tee` or script that opens the path) at `~/.claude/ship-it/runs/acme-books/invoices/<plan slug>.json`, in JSON or in a script's dictionary, with `"mode": "merge-ready"`. In it the PDF PR (its title names PDF) has a `depends_on` entry on the log PR (its title names the log) with `"needs": "evidence"`, and the log PR's `depends_on` is empty. Each PR is found by its title, and its `depends_on` read wherever it sits in the PR, so key order does not matter. The eval sandbox refuses every write under `~/.claude`, so the grader reads the write the skill made, from the trace, and not the file.
