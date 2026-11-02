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

# Nothing git reads from the operator's shell reaches the fixture: every
# inherited GIT_* variable is dropped (config passed in the environment, a
# template directory, another hash, another identity or date), and so is
# the global and system config. A hook template, a default branch, signing
# or line-ending settings would change main's SHA or refuse the push. The
# fixture's own GIT_* variables are set after this.
while IFS= read -r name; do
  unset "$name"
done < <(compgen -e | grep '^GIT_')
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=0

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

bun_binary="$(command -v bun)"

mkdir -p .fake-bin
# The session's git, the fake gh's and the bun wrapper's skip the
# operator's global, system and environment config too.
printf '#!/bin/sh\nGIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=0 exec "%s" "$@"\n' "$git_binary" > .fake-bin/git
cp "$fixtures/fake-gh.ts" .fake-bin/gh

# Logs each `bun test` run to the gh call log, in order with the gh calls,
# with its exit code, the commit it ran on, whether the work tree held
# changes, and the tree of the code it ran (the work tree as a commit of it
# would hold it), so a grader can match a passing run to the PR's code.
cat > .fake-bin/bun <<'EOF'
#!/bin/sh
if [ "$1" != test ]; then
  exec "@BUN@" "$@"
fi
# The scratch index lives in .git: the sandbox refuses the system temp
# directory that mktemp picks.
index="$("@GIT@" rev-parse --absolute-git-dir 2>/dev/null)/eval-test-index.$$"
tree=""
if cp "$("@GIT@" rev-parse --git-path index 2>/dev/null)" "$index" 2>/dev/null; then
  tree=$(GIT_INDEX_FILE="$index" "@GIT@" add -A 2>/dev/null &&
    GIT_INDEX_FILE="$index" "@GIT@" write-tree 2>/dev/null)
  rm -f "$index"
fi
"@BUN@" "$@"
status=$?
head=$("@GIT@" rev-parse HEAD 2>/dev/null)
dirty=false
if [ -n "$("@GIT@" status --porcelain 2>/dev/null)" ]; then
  dirty=true
fi
printf '{"event":"bun.test","exit":%d,"head":"%s","dirty":%s,"tree":"%s"}\n' "$status" "$head" "$dirty" "$tree" >> "@LOG@"
exit "$status"
EOF
sed -i.template \
  -e "s|@BUN@|$bun_binary|g" \
  -e "s|@GIT@|$PWD/.fake-bin/git|g" \
  -e "s|@LOG@|$PWD/.fake-bin/gh-calls.jsonl|g" \
  .fake-bin/bun
rm .fake-bin/bun.template
chmod +x .fake-bin/git .fake-bin/gh .fake-bin/bun

git init -q --bare -b main "$remote"
mkdir -p "$remote/.fake-bin"
cp .fake-bin/git "$remote/.fake-bin/git"

git remote add origin "https://github.com/$repository.git"
git config "url.$PWD/$remote.insteadOf" "https://github.com/$repository.git"
git config remote.origin.receivepack "$(git --exec-path)/git-receive-pack"
git config remote.origin.uploadpack "$(git --exec-path)/git-upload-pack"
git config push.default current
git config commit.gpgsign false
git config tag.gpgsign false

# Fixed dates and identities make the fixture's commits, and so main's
# SHA, the same in every run, so a grader can tell whether main moved.
export GIT_AUTHOR_DATE="2026-10-20T09:00:00Z" GIT_COMMITTER_DATE="2026-10-20T09:00:00Z"
export GIT_AUTHOR_NAME="Acme Developer" GIT_AUTHOR_EMAIL="dev@acme-books.example"
export GIT_COMMITTER_NAME="Acme Developer" GIT_COMMITTER_EMAIL="dev@acme-books.example"
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
