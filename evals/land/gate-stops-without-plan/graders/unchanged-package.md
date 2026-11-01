---
type: regex
target:
  source: file
  path: package.json
pattern: "^\\{\n  \"name\": \"acme-invoices\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": \\{\n    \"test\": \"bun test\"\n  \\}\n\\}\n$"
---

`package.json` holds exactly what the fixture put there, so no tool, a shell command included, changed it. `test/eval-graders.test.ts` fails when the fixture file and this pattern drift apart.
