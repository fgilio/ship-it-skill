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

git add package.json README.md .github src/invoices.ts test
git commit -q -m "Look up invoices and their totals"
git add src/cli.ts
git commit -q -m "Download an invoice as text or csv from the command line"
git push -q origin main
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
