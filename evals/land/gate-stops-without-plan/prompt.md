---
description: A one-line request with no plan makes land stop at its gate.
expected_outcome: Land stops, lists the missing parts of the plan statement, and creates no branch, no commit and no pull request.
tags: [land, gate]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
---

/ship-it:land add PDF downloads to the invoices
