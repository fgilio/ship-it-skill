---
type: regex
target:
  source: file
  path: src/cli.ts
pattern: 'Usage: bun src/cli\.ts list \| download <invoice id> \[--format text\|csv\]'
---

`src/cli.ts` still offers exactly the text and csv formats, so no shell command rewrote the command line tool either.
