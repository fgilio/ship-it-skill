---
type: llm
---

PASS if the final message hands `https://github.com/acme-books/invoices/pull/1` to the user to merge, AND says the PDF PR has not started because it waits for PR 1 to be merged and deployed and for its download logs.

FAIL if the message says the PDF PR was implemented, branched or opened, or that PR 1 was merged.
