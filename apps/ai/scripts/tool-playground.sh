#!/usr/bin/env bash
# Call Maple's MCP tools against a fixture world and print what a model would read.
#
#   scripts/tool-playground.sh catalog
#   scripts/tool-playground.sh schema inspect_infra
#   scripts/tool-playground.sh call list_infra '{"kind":"pods"}'
#
# PLAYGROUND_LOG=<file.jsonl> appends every call for grading. See src/evals/playground/.
set -euo pipefail
cd "$(dirname "$0")/.."

out="$(mktemp -t maple-playground)"
PLAYGROUND_CMD="${1:-}" PLAYGROUND_TOOL="${2:-}" PLAYGROUND_ARGS="${3:-{\}}" PLAYGROUND_OUT="$out" \
	bunx vitest run --config vitest.playground.config.ts --reporter=dot --silent >/dev/null 2>"$out.err" || {
	echo "playground run failed:" >&2
	tail -40 "$out.err" >&2
	exit 1
}
cat "$out"
echo
rm -f "$out" "$out.err"
