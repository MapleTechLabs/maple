#!/usr/bin/env bash
# Build the distributable `maple` local binary.
#
# Pipeline:
#   1. Build the lightweight SPA (`apps/local-ui` → its `dist/`).
#   2. Sync that `dist/` into `apps/ingest/ui-dist/` so rust-embed bakes the
#      UI assets into the binary at compile time.
#   3. Compile the query CLI (`apps/local-cli`) into `apps/ingest/cli-dist/`
#      so rust-embed also bakes the CLI binary into `maple` at compile time.
#      The CLI is embedded — not shipped separately.
#   4. Compile the `maple` bin target with the `local` feature (chDB + clap +
#      rust-embed + mime_guess). rust-embed picks up both ui-dist/ and cli-dist/.
#   5. Bundle `libchdb.so` next to the binary and rewrite the dynamic-load path
#      so the binary is relocatable (no DYLD_LIBRARY_PATH / LD_LIBRARY_PATH).
#
# The distributable is a 2-file bundle: `maple` + `libchdb.so`. The query CLI
# is embedded inside `maple` and extracted to ~/.maple/ on first use.
# chdb-rust links `libchdb.so` with a bare install name, so the script rewrites
# the load path to @rpath/$ORIGIN so the loader finds it beside the binary.
#
# Usage:
#   scripts/build-local-binary.sh            # release build
#   PROFILE=debug scripts/build-local-binary.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIST="$REPO_ROOT/apps/local-ui/dist"
EMBED_DIR="$REPO_ROOT/apps/ingest/ui-dist"
CLI_EMBED_DIR="$REPO_ROOT/apps/ingest/cli-dist"
PROFILE="${PROFILE:-release}"
INGEST_DIR="$REPO_ROOT/apps/ingest"
OUT_BIN="$INGEST_DIR/target/$PROFILE/maple"

echo "==> Building local-ui SPA"
bun --filter @maple/local-ui build

echo "==> Syncing $UI_DIST -> $EMBED_DIR"
rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"
cp -R "$UI_DIST"/. "$EMBED_DIR"/

echo "==> Compiling query CLI -> cli-dist/maple-cli (embedded into maple)"
rm -rf "$CLI_EMBED_DIR"
mkdir -p "$CLI_EMBED_DIR"
( cd "$REPO_ROOT" && bun build apps/local-cli/src/bin.ts --compile --outfile "$CLI_EMBED_DIR/maple-cli" )

echo "==> Compiling maple binary ($PROFILE, with embedded SPA + CLI)"
CARGO_FLAGS=(--features local --bin maple)
if [ "$PROFILE" = "release" ]; then
	CARGO_FLAGS+=(--release)
fi
( cd "$INGEST_DIR" && cargo build "${CARGO_FLAGS[@]}" )

echo "==> Bundling libchdb beside the binary (relocatable)"
LIBCHDB="$(find "$INGEST_DIR/target/$PROFILE/build" -name 'libchdb.so' 2>/dev/null | head -1 || true)"
if [ -z "$LIBCHDB" ]; then
	echo "ERROR: libchdb.so not found under target/$PROFILE/build — was chdb-rust built?" >&2
	exit 1
fi
cp "$LIBCHDB" "$(dirname "$OUT_BIN")/libchdb.so"

case "$(uname -s)" in
	Darwin)
		# Add an @loader_path rpath (ignore if it already exists) and repoint the
		# bare `libchdb.so` load command at it.
		install_name_tool -add_rpath @loader_path "$OUT_BIN" 2>/dev/null || true
		install_name_tool -change libchdb.so @rpath/libchdb.so "$OUT_BIN"
		;;
	Linux)
		# Prefer patchelf to set an $ORIGIN rpath so the loader finds the sibling
		# libchdb.so. If patchelf is unavailable, the bundle still works when the
		# binary is launched with LD_LIBRARY_PATH=. (documented in the release).
		if command -v patchelf >/dev/null 2>&1; then
			patchelf --set-rpath '$ORIGIN' "$OUT_BIN"
		else
			echo "WARN: patchelf not found; run with LD_LIBRARY_PATH=\$(dirname maple)" >&2
		fi
		;;
esac

echo "==> Done. Bundle in $(dirname "$OUT_BIN"):"
echo "      maple        ($(du -h "$OUT_BIN" | cut -f1), includes embedded query CLI)"
echo "      libchdb.so   ($(du -h "$(dirname "$OUT_BIN")/libchdb.so" | cut -f1))"
