#!/usr/bin/env bash
# Creates a small git repository with a "main" branch and a "fix/basket-count" branch,
# so you can try MergeStory without a GitHub pull request:
#
#   ./examples/bugfix-demo/create-demo-repo.sh /tmp/mergestory-bugfix-demo
#   mergestory generate /tmp/mergestory-bugfix-demo --base main --head fix/basket-count
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-${TMPDIR:-/tmp}/mergestory-bugfix-demo}"

if [ -e "$target" ]; then
  echo "error: $target already exists; pass another path or remove it first" >&2
  exit 1
fi

mkdir -p "$target"
cd "$target"
git init -q -b main
git config user.name "Demo Author"
git config user.email "demo@example.com"
git config commit.gpgsign false

cp -R "$here/base/." .
git add -A
git commit -q -m "Add a basket page with two quantity fields"

git checkout -q -b fix/basket-count
cp -R "$here/feature/." .
git add -A
git commit -q -m "Count the basket items as numbers" \
  -m "The quantity fields give text, so 2 and 3 were joined into 23. basketCount now turns both into numbers before it adds them."

echo "Demo repository ready: $target"
echo "Try: mergestory generate $target --base main --head fix/basket-count"
