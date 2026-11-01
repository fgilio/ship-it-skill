---
type: regex
target:
  source: file
  path: README.md
pattern: "^# Acme Books invoices\n\nThe command line tool Acme Books support uses to look up customer invoices\\.\n\n```bash\nbun src\\/cli\\.ts list                         # every invoice with its total\nbun src\\/cli\\.ts download INV-1001            # one invoice as text\nbun src\\/cli\\.ts download INV-1001 --format csv\n```\n\n## Checks\n\n`bun test` runs the tests\\. CI runs the same command on every pull request, as the `test` check, and the merge requires it\\.\n(?![\\s\\S])"
---

`README.md` holds exactly what the fixture put there, to the last byte (a trailing newline included), so no tool, a shell command included, changed it. `test/eval-graders.test.ts` fails when the fixture file and this pattern drift apart.
