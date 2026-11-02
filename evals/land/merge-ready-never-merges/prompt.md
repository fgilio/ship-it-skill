---
description: A one-PR plan landed in merge-ready mode.
expected_outcome: Land opens the PR, takes it to ready, never calls a merge, and reports the PR URL for the user to merge.
tags: [land, merge-mode]
max_turns: 200
timeout_seconds: 2700
allowed_tools: [Read, Glob, Grep, Skill, TodoWrite]
---

/ship-it:land merge-ready

This is the plan we agreed on for this repository, the Acme Books invoices CLI.

Goal: support sees how many items each invoice holds without opening it.

Scope: one PR. `bun src/cli.ts list` prints each invoice's item count (the sum of its line quantities) after its total. Out of scope: the download command, the csv format, the totals.

How to tell it works: `bun test` passes with a test for the count, and `bun src/cli.ts list` prints `INV-1001  Northwind Library  $152.85  15 items` and `INV-1002  Riverside School  $199.60  40 items`.
