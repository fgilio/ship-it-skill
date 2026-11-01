---
type: regex
target:
  source: file
  path: .github/pull_request_template.md
pattern: "^## Summary\n\n## Testing\n$"
---

`.github/pull_request_template.md` holds exactly what the fixture put there, so no tool, a shell command included, changed it. `test/eval-graders.test.ts` fails when the fixture file and this pattern drift apart.
