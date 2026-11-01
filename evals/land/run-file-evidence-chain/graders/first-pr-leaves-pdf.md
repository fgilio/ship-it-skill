---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: "\"event\":\"pr\\.create\"[^\\n]*\"pdfLines\":0[,}]"
---

The logging PR leaves the PDF work alone: no line its diff adds outside the tests names the PDF format, in a source, the README or `package.json`. The fake gh counts them at `pr create`. Tests may name `pdf` as a format the CLI refuses, as the fixture's own test does. A test that expects PDF to work fails the PR's test run, which `tests-pass-after-change` reads.
