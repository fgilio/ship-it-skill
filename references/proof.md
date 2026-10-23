# Proof

A proof shows that the change works the way the user meant, with evidence a reviewer can check without running anything. A reviewer who reads the proof first stops hunting for bugs in code that demonstrably works, and spends the review on the approach and on the load-bearing code.

## Prove

Exercise the change the way its user does, with the repository's own means: the dev server and a browser for a page, the CLI for a command, an HTTP call for an endpoint, a run of the job for a job, the test suite on the real flow for a library. The repository's CLAUDE.md, AGENTS.md, README or verification skill says how to start and drive it.

- Cover the cases the change is about: the main path, each edge the plan named, and one existing path the change must not break.
- Keep the evidence: commands and their output, response bodies, log lines, query results, and screenshots of UI when the session can attach images to the PR. Strip secrets and personal data.
- For a change that claims to keep behavior (a refactor), run the same inputs on the default branch and on the change, and compare the outputs.
- When the session cannot run the change (no dev environment it can start, a third party it cannot reach), name exactly what blocked the proof. Passing unit tests are a check, not a proof, so they never stand in for one.

The artifact is a test matrix, one row per case: the case, how it ran, the result, and the evidence.

## Write it in the PR

The description carries two sections, inside the template's testing section when the repository's PR template has one:

- **Proof**: the test matrix, then the evidence, folded into `<details>` when it runs long.
- **Reading guide**: the files a reviewer must read, each with one line on why it bears load (a migration, permission logic, money, concurrency or locking, a primitive many callers share, a hot path), then what can be skimmed (tests, copy, styles, mechanical renames). When every file bears load, the PR is too big to read: split it.

## Keep it current

A fix that changes behavior leaves the proof describing an older head. Before a PR counts as ready, run again the cases the fixes touched, and update both sections.
