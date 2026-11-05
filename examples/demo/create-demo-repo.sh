#!/usr/bin/env bash
# Creates a small git repository with a "main" branch and a "feature/retry" branch,
# so you can try MergeStory without a GitHub pull request:
#
#   ./examples/demo/create-demo-repo.sh /tmp/mergestory-demo
#   mergestory generate /tmp/mergestory-demo --base main --head feature/retry
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-${TMPDIR:-/tmp}/mergestory-demo}"

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
git commit -q -m "Add a small weather API client"

git checkout -q -b feature/retry
cp -R "$here/feature/." .
git add -A
git commit -q -m "Retry temporary failures with exponential backoff" \
  -m "getForecast now retries network errors, 429 and 5xx with full-jitter backoff, and honours Retry-After. Other 4xx errors fail at once. WEATHER_RETRIES, WEATHER_BASE_DELAY_MS and WEATHER_MAX_DELAY_MS tune the retries."

echo "Demo repository ready: $target"
echo "Try: mergestory generate $target --base main --head feature/retry"
