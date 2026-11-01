---
type: regex
target: files
flags: im
pattern: '^(?!\.git/)[^\n]*pdf'
match: not_contains
---

The session created no file whose path names the PDF format: no PDF module, test or rendered invoice. Git's own files are left out, since a branch name may mention the PDF PR to come.
