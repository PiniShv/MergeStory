#!/usr/bin/env bash
# Creates two small git repositories, "orders-api" and "storefront", in one folder. Each has a
# "main" branch and a "fix/total-cents" branch. The fix needs both: the service gives the total in
# cents and the page reads cents. Try MergeStory on them without a GitHub pull request:
#
#   ./examples/two-repos-demo/create-demo-repos.sh /tmp/mergestory-two-repos
#   mergestory generate --source /tmp/mergestory-two-repos/orders-api:main..fix/total-cents \
#     --source /tmp/mergestory-two-repos/storefront:main..fix/total-cents --storyboard storyboard.json
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-${TMPDIR:-/tmp}/mergestory-two-repos}"

if [ -e "$target" ]; then
  echo "error: $target already exists; pass another path or remove it first" >&2
  exit 1
fi

make_repo() {
  local name="$1" first="$2" second="$3" detail="$4"
  mkdir -p "$target/$name"
  (
    cd "$target/$name"
    git init -q -b main
    git config user.name "Demo Author"
    git config user.email "demo@example.com"
    git config commit.gpgsign false
    cp -R "$here/$name/base/." .
    git add -A
    git commit -q -m "$first"
    git checkout -q -b fix/total-cents
    cp -R "$here/$name/feature/." .
    git add -A
    git commit -q -m "$second" -m "$detail"
  )
}

make_repo orders-api "Add the orders service" "Answer with the total in cents and its currency" \
  "The answer used to call the total just total. It now says totalCents and gives the currency, so a reader cannot take cents for euros."
make_repo storefront "Add the shop page" "Show the total from cents" \
  "The page took the total as euros and showed a price that was a hundred times too big. It now reads totalCents and divides by one hundred."

echo "Demo repositories ready: $target/orders-api and $target/storefront"
