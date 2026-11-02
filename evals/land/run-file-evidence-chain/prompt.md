---
description: A two-PR plan where the second PR needs the first one's evidence.
expected_outcome: Land writes the run file with the second PR depending on the first for evidence, opens only the first PR as a draft, marks it ready once CI passes, and stops at merge-ready without starting the second PR.
tags: [land, run-file, chain]
max_turns: 200
timeout_seconds: 2700
allowed_tools: [Read, Glob, Grep, Skill, TodoWrite]
---

/ship-it:land merge-ready

We settled the plan for invoice downloads in this repository, the Acme Books invoices CLI.

Goal: support can download invoices as PDF, with the default format chosen from how support downloads invoices today.

Scope, as two PRs in this order:

1. "Log invoice downloads": every `bun src/cli.ts download` run appends one JSON line (the invoice id, the format, an ISO timestamp) to `logs/downloads.jsonl`, and prints exactly what it prints today.
2. "Add the PDF download format": `download <id> --format pdf` writes `<id>.pdf`. It needs the evidence of PR 1: once PR 1 is deployed, one week of `logs/downloads.jsonl` from production shows which formats support downloads and how often, and that decides whether `pdf` becomes the default. It starts only after that evidence is in.

Out of scope: emailing invoices, the csv format, the totals, any web page.

How to tell it works: for PR 1, `bun test` passes, and a `download` run adds exactly one line to `logs/downloads.jsonl` while its output stays the same. For PR 2, a `--format pdf` run writes a file that starts with `%PDF-` and holds the invoice id and total, and the default format follows what the logs showed.
