# Escalation

The channel follows how much a question blocks. Ask only what code, tests and earlier decisions cannot settle: intent, scope, accepted risk, and product calls.

| Situation | Channel |
| --- | --- |
| **Can wait**: other work goes on meanwhile | Save the question and keep working. Ask every saved question together at the next natural stop (the end of a review round, the end of the run), in one AskUserQuestion. |
| **Blocked**: nothing useful goes on until the user answers | A push notification that names what blocks, then AskUserQuestion. |
| **Production problem** after a deploy | A Slack DM and a push notification at once, then AskUserQuestion. |

- **Push notification**: the harness's push tool. In a harness without one, the message alone.
- **Slack DM**: the session's Slack tool, sent from the user's own account to the user's own user id (the id the tool reports for the logged-in user). In a session without a Slack tool, the push notification alone.
- Every escalation carries what happened, the evidence as links, the options with a recommendation, and what the agent does while it waits.
