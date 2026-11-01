#!/usr/bin/env bash
# Builds the workspace every land case starts in: the Acme Books invoices
# repository on main, pushed to a local stand-in for its GitHub remote, and
# a fake gh that logs every call. Each case's scaffold.sh runs it from the
# empty workspace. The run's sandbox shapes three choices here:
#
# - Commands resolve gh and git through the relative PATH entry
#   `.fake-bin`, which the operator adds, so the repository sits at the
#   workspace root and the remote carries its own `.fake-bin`.
# - The macOS /usr/bin/git shim needs a cache the sandbox refuses, so the
#   git wrappers call the git binary the scaffold found.
# - The sandbox refuses writes to .git/config, so everything git config
#   holds is set here.
set -euo pipefail

case ":$PATH:" in
  *":.fake-bin:"*) ;;
  *)
    # shellcheck disable=SC2016 # The message shows $PATH as the user types it.
    echo 'The land evals need the fake gh on PATH. Run the suite with PATH=".fake-bin:$PATH", as evals/README.md shows.' >&2
    exit 1
    ;;
esac

fixtures="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository="acme-books/invoices"
remote=".git/fake-remote/$repository.git"
git_binary="$(git --exec-path)/git"

# The fixture's history must not depend on the user's git config: no
# signature, no hook, no line-ending conversion, or main's SHA changes.
history() {
  git -c commit.gpgsign=false -c tag.gpgsign=false \
    -c core.hooksPath=/dev/null -c core.autocrlf=false "$@"
}

cp -R "$fixtures/repo/." .

git init -q -b main .
git config user.name "Acme Developer"
git config user.email "dev@acme-books.example"
printf '.fake-bin/\n' >> .git/info/exclude

mkdir -p .fake-bin
printf '#!/bin/sh\nexec "%s" "$@"\n' "$git_binary" > .fake-bin/git
cp "$fixtures/fake-gh.ts" .fake-bin/gh
chmod +x .fake-bin/git .fake-bin/gh

git init -q --bare "$remote"
mkdir -p "$remote/.fake-bin"
cp .fake-bin/git "$remote/.fake-bin/git"

git remote add origin "https://github.com/$repository.git"
git config "url.$PWD/$remote.insteadOf" "https://github.com/$repository.git"
git config remote.origin.receivepack "$(git --exec-path)/git-receive-pack"
git config remote.origin.uploadpack "$(git --exec-path)/git-upload-pack"
git config push.default current
git config commit.gpgsign false
git config tag.gpgsign false

# Fixed dates make the fixture's commits, and so main's SHA, the same in
# every run, so a grader can tell whether main moved.
export GIT_AUTHOR_DATE="2026-10-20T09:00:00Z" GIT_COMMITTER_DATE="2026-10-20T09:00:00Z"
history add package.json README.md .github src/invoices.ts test
history commit -q --no-gpg-sign -m "Look up invoices and their totals"
history add src/cli.ts
GIT_AUTHOR_DATE="2026-10-21T09:00:00Z" GIT_COMMITTER_DATE="2026-10-21T09:00:00Z" \
  history commit -q --no-gpg-sign -m "Download an invoice as text or csv from the command line"
history push -q origin main
git remote set-head origin main

cat > .fake-bin/state.json <<EOF
{
  "repo": "$repository",
  "login": "acme-dev",
  "defaultBranch": "main",
  "remote": "$PWD/$remote",
  "requiredCheck": "test",
  "pulls": []
}
EOF
: > .fake-bin/gh-calls.jsonl
