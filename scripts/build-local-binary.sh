#!/usr/bin/env bash
# Build the distributable `maple` local binary — a single Bun-compiled
# executable plus the npm chdb runtime sidecar. No Rust/cargo involved.
#
# Pipeline:
#   1. Build the workspace packages consumed through gitignored `dist/` paths.
#   2. Build the lightweight SPA (`apps/local-ui` → its `dist/`).
#   3. Inline that dist into apps/cli/src/server/ui-embed.gen.ts so
#      `bun build --compile` bakes the SPA into the binary.
#   4. Compile apps/cli (the CLI + the OTLP-ingest/query server) into a single
#      executable with `bun build --compile`. The schema artifacts and SPA are
#      embedded; the OTLP encoders run in-process; chDB is reached via the
#      published `chdb` npm package.
#   5. Copy the npm chdb runtime (`chdb` plus the installed platform package)
#      beside the binary under node_modules. At runtime compiled Maple resolves
#      `chdb` from that sidecar, while source/dev runs resolve workspace
#      node_modules normally.
#   6. Restore the committed ui-embed.gen.ts stub so the tree stays clean.
#
# The distributable is a bundle directory: `maple` + `node_modules/chdb` and its
# matching `node_modules/@chdb/lib-*` platform package. Keep the sidecar next to
# the binary.
#
# Usage:
#   scripts/build-local-binary.sh                 # release build into ./dist
#   OUT_DIR=/tmp/maple scripts/build-local-binary.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
UI_EMBED="$REPO_ROOT/apps/cli/src/server/ui-embed.gen.ts"
CLI_NODE_MODULES="$REPO_ROOT/apps/cli/node_modules"
ROOT_NODE_MODULES="$REPO_ROOT/node_modules"

# Version baked into the binary via `bun build --define`. The release workflow
# passes the tag; a local build defaults to `git describe` (or "dev").
MAPLE_BUILD_VERSION="${MAPLE_BUILD_VERSION:-$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo dev)}"
CHDB_VERSION="${CHDB_VERSION:-$(bun "$REPO_ROOT/scripts/resolve-chdb-version.ts")}"

copy_runtime_pkg() {
	local pkg="$1"
	local src=""
	for candidate in "$CLI_NODE_MODULES/$pkg" "$ROOT_NODE_MODULES/$pkg" "$ROOT_NODE_MODULES/.bun/node_modules/$pkg"; do
		if [ -d "$candidate" ]; then
			src="$candidate"
			break
		fi
	done
	local dst="$OUT_DIR/node_modules/$pkg"
	if [ -z "$src" ]; then
		echo "ERROR: runtime package not installed: $pkg" >&2
		echo "       run bun install --frozen-lockfile before building" >&2
		exit 1
	fi
	mkdir -p "$(dirname "$dst")"
	rm -rf "$dst"
	cp -RL "$src" "$dst"
}

copy_runtime_pkg_from() {
	local pkg="$1"
	local src="$2"
	local dst="$OUT_DIR/node_modules/$pkg"
	mkdir -p "$(dirname "$dst")"
	rm -rf "$dst"
	cp -RL "$src" "$dst"
}

mkdir -p "$OUT_DIR"

# Several workspace packages are published from gitignored `dist/` directories.
# A fresh checkout / CI only runs `bun install`, so build the repository's
# canonical prerequisite set before local-ui or the CLI resolves those imports.
echo "==> Building workspace prerequisites"
bun run alchemy:build-deps

echo "==> Building local-ui SPA"
bun run --filter @maple/local-ui build

echo "==> Inlining SPA into ui-embed.gen.ts"
restore_stub() { git -C "$REPO_ROOT" checkout -- "$UI_EMBED" 2>/dev/null || true; }
trap restore_stub EXIT
bun run "$REPO_ROOT/scripts/gen-ui-embed.ts"

echo "==> Compiling maple binary (bun build --compile) — version $MAPLE_BUILD_VERSION, chDB $CHDB_VERSION"
( cd "$REPO_ROOT" && bun build apps/cli/src/bin.ts --compile \
	--define "__MAPLE_VERSION__=\"$MAPLE_BUILD_VERSION\"" \
	--define "__CHDB_VERSION__=\"$CHDB_VERSION\"" \
	--outfile "$OUT_DIR/maple" )

echo "==> Copying npm chdb runtime sidecar"
rm -rf "$OUT_DIR/node_modules"
copy_runtime_pkg chdb
copy_runtime_pkg node-addon-api
copy_runtime_pkg node-gyp-build
copy_runtime_pkg @clickhouse/client-common
found_platform_pkg=0
for pkg in "$ROOT_NODE_MODULES"/.bun/node_modules/@chdb/lib-* "$ROOT_NODE_MODULES"/.bun/@chdb+lib-*/node_modules/@chdb/lib-*; do
	[ -d "$pkg" ] || continue
	copy_runtime_pkg_from "@chdb/$(basename "$pkg")" "$pkg"
	found_platform_pkg=1
done
if [ "$found_platform_pkg" != 1 ]; then
	echo "ERROR: no @chdb/lib-* platform package installed" >&2
	exit 1
fi

echo "==> Done. Bundle in $OUT_DIR:"
echo "      maple        ($(du -h "$OUT_DIR/maple" | cut -f1))"
echo "      node_modules ($(du -sh "$OUT_DIR/node_modules" | cut -f1))"
