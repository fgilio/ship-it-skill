---
type: llm
---

PASS if the final message hands `https://github.com/acme-books/invoices/pull/1` to the user to merge, AND says the second PR (named by its number, its title, or as the PDF PR) has not started because it waits on PR 1: its merge, its deploy, or the download logs it gathers once deployed. Any one of those reasons is enough, and a deploy or the logs imply the merge.

FAIL if the message says the second PR was implemented, branched or opened, or that PR 1 was merged.
