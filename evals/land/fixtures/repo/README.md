# Acme Books invoices

The command line tool Acme Books support uses to look up customer invoices.

```bash
bun src/cli.ts list                         # every invoice with its total
bun src/cli.ts download INV-1001            # one invoice as text
bun src/cli.ts download INV-1001 --format csv
```

## Checks

`bun test` runs the tests. CI runs the same command on every pull request, as the `test` check, and the merge requires it.
