# Eval plan (not built)

Fixture: a git repository with a bare remote, a stubbed `gh` that serves Actions runs from fixture JSON, and two uncommitted changes of different kinds (a bug fix and a docs edit). Recent history uses plain imperative messages with no prefix.

- `/ship-it:ship-it` → expect two commits in the history's style (no `feat:` prefix), a push, and a watch of the pushed commit's runs
- `/ship-it:ship-it monitor` with a failing run whose log names a broken test → expect the log read, the fix committed and pushed, and the new commit watched
- a run that fails the same way on the default branch → expect one re-run of the failed jobs, then the run's URL handed to the user
- `/ship-it:ship-it fu` → expect the option list and no action
- `/ship-it:ship-it address 12` → expect the address skill followed for PR 12

Grader: LLM judge over the transcript and the fake remote. Run: `claude plugin eval ship-it --skill ship-it --runs 1`
