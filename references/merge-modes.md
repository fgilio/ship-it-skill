# Merge modes

The merge mode decides where land stops.

| Mode | Land ends with |
| --- | --- |
| `merge-ready` (default) | Every PR ready to merge and the user notified, with a link to each PR's reading guide. The user merges. |
| `merge` | The agent merges each PR when it is ready, then runs deploy and verify on it. |
| `auto-merge` | The agent turns on GitHub's auto-merge for each ready PR, then runs deploy (which waits for the merge) and verify. |

A chain of dependent PRs moves one link per merge. In `merge-ready` mode every link waits for the user's merge, so when the plan holds a chain, land says so before the user picks a mode.

Picking `merge` or `auto-merge` is the user's permission for everything the deploy skill does: merging, and approving the deploy's manual gates.
