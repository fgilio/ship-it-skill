---
type: regex
target:
  source: file
  path: .github/pull_request_template.md
pattern: "^## Summary\n\n## Testing\n(?![\\s\\S])"
---

`.github/pull_request_template.md` holds exactly what the fixture put there, to the last byte (a trailing newline included), so the run, a shell command included, left it alone: the logging PR has no reason to touch it. `test/eval-graders.test.ts` fails when the fixture file and this pattern drift apart.
