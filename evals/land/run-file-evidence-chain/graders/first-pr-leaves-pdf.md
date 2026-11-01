---
type: regex
target:
  source: file
  path: .fake-bin/gh-calls.jsonl
pattern: "\"event\":\"pr\\.create\"[^\\n]*\"pdfLines\":0[,}]"
---

The logging PR leaves the PDF work alone: no line its diff adds names the PDF format, in a source, a test, the README or `package.json`. The fake gh counts them at `pr create`.
