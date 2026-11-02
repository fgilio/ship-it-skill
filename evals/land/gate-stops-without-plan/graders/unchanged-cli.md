---
type: regex
target:
  source: file
  path: src/cli.ts
pattern: "^import \\{\n  DOWNLOAD_FORMATS,\n  findInvoice,\n  formatCents,\n  INVOICES,\n  invoiceTotalInCents,\n  isDownloadFormat,\n  renderInvoice,\n\\} from \"\\.\\/invoices\"\\x3b\n\nconst \\[command, id, \\.\\.\\.options\\] = process\\.argv\\.slice\\(2\\)\\x3b\n\nfunction fail\\(message: string\\): never \\{\n  process\\.stderr\\.write\\(`\\$\\{message\\}\\\\n`\\)\\x3b\n  process\\.exit\\(1\\)\\x3b\n\\}\n\nif \\(command === \"list\"\\) \\{\n  for \\(const invoice of INVOICES\\) \\{\n    console\\.log\\(\n      `\\$\\{invoice\\.id\\}  \\$\\{invoice\\.customer\\}  \\$\\{formatCents\\(invoiceTotalInCents\\(invoice\\)\\)\\}`,\n    \\)\\x3b\n  \\}\n\\} else if \\(command === \"download\"\\) \\{\n  const invoice =\n    findInvoice\\(id \\?\\? \"\"\\) \\?\\? fail\\(`Unable to find invoice: \\$\\{id\\}`\\)\\x3b\n  const formatIndex = options\\.indexOf\\(\"--format\"\\)\\x3b\n  const requested =\n    formatIndex === -1 \\? \"text\" : \\(options\\[formatIndex \\+ 1\\] \\?\\? \"\"\\)\\x3b\n\n  if \\(!isDownloadFormat\\(requested\\)\\) \\{\n    fail\\(\n      `The format must be one of \\$\\{DOWNLOAD_FORMATS\\.join\\(\", \"\\)\\}, got \"\\$\\{requested\\}\"\\.`,\n    \\)\\x3b\n  \\}\n\n  console\\.log\\(renderInvoice\\(invoice, requested\\)\\)\\x3b\n\\} else \\{\n  fail\\(\n    \"Usage: bun src\\/cli\\.ts list \\| download <invoice id> \\[--format text\\|csv\\]\",\n  \\)\\x3b\n\\}\n(?![\\s\\S])"
---

`src/cli.ts` holds exactly what the fixture put there, to the last byte (a trailing newline included), so no tool, a shell command included, changed it. `test/eval-graders.test.ts` fails when the fixture file and this pattern drift apart.
