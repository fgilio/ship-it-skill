# ship-it skill

A Claude Code skill that ships a change: granular commits, push, GitHub Actions watched until green, the PR, and the follow-up on its review threads (fix, answer or escalate each one, reply, resolve).

Everything lives in [SKILL.md](skills/ship-it/SKILL.md).

## Stages

The argument picks the stages:

- **(none)**: commit, push, monitor
- **commit**: commit only
- **push**: commit and push
- **monitor**: watch the branch's GitHub Actions and fix what fails
- **pr**: commit, push, open the PR, monitor
- **follow-up**, **fu**: sweep the session's PRs for review feedback, address it, reply, resolve

```
/ship-it
/ship-it pr
/ship-it fu
```

The commands above assume a skills-directory install. Installed as a plugin, skills are namespaced as `/<plugin>:<skill>`, so the command becomes `/ship-it:ship-it`.

## Guardrails

With [bonsai](https://github.com/publicala/claude-plugins/tree/main/plugins/bonsai) installed, `fu` hands the PRs to `/bonsai:guard` before it replies. Guard turns findings a check could have caught into one guardrail PR each, and every reply cites the guardrail PR next to the fix commit.

## Requirements

The GitHub CLI (`gh`), authenticated. PR descriptions follow the `pr-guidelines` skill and replies the `fgilio-voice` skill when the session has them.
