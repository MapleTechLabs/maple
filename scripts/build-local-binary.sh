#!/usr/bin/env bash
# Build the distributable `maple` local binary — a single Bun-compiled
# executable plus libchdb. No Rust/cargo involved.
#
# Pipeline:
#   1. Build the workspace packages consumed through gitignored `dist/` paths.
#   2. Build the lightweight SPA (`apps/local-ui` → its `dist/`).
#   3. Inline that dist into packages/local-server/src/ui-embed.gen.ts so
#      `bun build --compile` bakes the SPA into the binary.
#   4. Compile apps/cli (the CLI + the OTLP-ingest/query server) into a single
#      executable with `bun build --compile`. The schema artifacts and SPA are
#      embedded; the OTLP encoders run in-process; chDB is reached via bun:ffi.
#   5. Download libchdb (pinned in packages/local-server/libchdb.json) for the host
#      platform and place it beside the binary. At runtime `maple` dlopens the
#      sibling libchdb (resolved relative to its own path) — no rpath tricks.
#   6. Restore the committed ui-embed.gen.ts stub so the tree stays clean.
#
# The distributable is a 2-file bundle: `maple` + `libchdb.so`. Keep them in the
# same directory.
#
# Usage:
#   scripts/build-local-binary.sh                 # release build into ./dist
#   OUT_DIR=/tmp/maple scripts/build-local-binary.sh
#   MAPLE_TARGET=linux-arm64 scripts/build-local-binary.sh   # cross-compile (e.g. a container image from macOS)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
# The chDB release this build pairs with, and each platform asset's sha256. The
# @maple-dev/alchemy sidecar builds and downloads from the same manifest.
LIBCHDB_MANIFEST="$REPO_ROOT/packages/local-server/libchdb.json"
LIBCHDB_VERSION="${LIBCHDB_VERSION:-$(bun -p "require(process.argv[1]).version" "$LIBCHDB_MANIFEST")}"
UI_EMBED="$REPO_ROOT/packages/local-server/src/ui-embed.gen.ts"

# Version baked into the binary via `bun build --define`. The release workflow
# passes the tag; a local build defaults to `git describe` (or "dev").
MAPLE_BUILD_VERSION="${MAPLE_BUILD_VERSION:-$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo dev)}"

# Target platform: the host by default, or MAPLE_TARGET for a cross-compiled bundle.
# Only a cross-compile passes --target, so native builds compile exactly as before.
COMPILE_TARGET=()
if [ -n "${MAPLE_TARGET:-}" ]; then
	COMPILE_TARGET=(--target "bun-$MAPLE_TARGET")
else
	case "$(uname -s)-$(uname -m)" in
		Linux-x86_64)  MAPLE_TARGET="linux-x64" ;;
		Linux-aarch64) MAPLE_TARGET="linux-arm64" ;;
		Darwin-x86_64) MAPLE_TARGET="darwin-x64" ;;
		Darwin-arm64)  MAPLE_TARGET="darwin-arm64" ;;
		*) echo "ERROR: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
	esac
fi

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

echo "==> Compiling maple binary (bun build --compile) — version $MAPLE_BUILD_VERSION"
( cd "$REPO_ROOT" && bun build apps/cli/src/bin.ts --compile \
	--define "__MAPLE_VERSION__=\"$MAPLE_BUILD_VERSION\"" \
	--define "__CHDB_VERSION__=\"$LIBCHDB_VERSION\"" \
	${COMPILE_TARGET[@]+"${COMPILE_TARGET[@]}"} \
	--outfile "$OUT_DIR/maple" )

echo "==> Downloading libchdb $LIBCHDB_VERSION for $MAPLE_TARGET"
case "$MAPLE_TARGET" in
	linux-x64)    ASSET="linux-x86_64-libchdb.tar.gz" ;;
	linux-arm64)  ASSET="linux-aarch64-libchdb.tar.gz" ;;
	darwin-x64)   ASSET="macos-x86_64-libchdb.tar.gz" ;;
	darwin-arm64) ASSET="macos-arm64-libchdb.tar.gz" ;;
	*) echo "ERROR: unsupported MAPLE_TARGET $MAPLE_TARGET" >&2; exit 1 ;;
esac
# Expected sha256 per platform asset comes from the manifest: release assets are
# mutable even for a fixed tag, so this is verified before extraction. Bumping
# the release means updating its version and every asset hash there.
# v26.1.0's macos-arm64 dylib put its LINKEDIT string pool at a non-8-byte-aligned
# offset, which newer dyld rejects ("mis-aligned LINKEDIT string pool"). Check
# `otool -l libchdb.so` (LC_SYMTAB stroff % 8 == 0) before pinning a new release.
EXPECTED_SHA256="$(bun -p 'const m = require(process.argv[1]); m.version === process.argv[2] ? (m.sha256[process.argv[3]] ?? "") : ""' "$LIBCHDB_MANIFEST" "$LIBCHDB_VERSION" "$ASSET")"
if [ -z "$EXPECTED_SHA256" ]; then
	echo "ERROR: no pinned sha256 for $ASSET at LIBCHDB_VERSION=$LIBCHDB_VERSION (see $LIBCHDB_MANIFEST)" >&2
	exit 1
fi

URL="https://github.com/chdb-io/chdb-core/releases/download/$LIBCHDB_VERSION/$ASSET"
TMP="$(mktemp -d)"
# Release downloads 500 intermittently; plain --retry covers 5xx and timeouts
# without retrying a permanent 404.
curl -fsSL --retry 5 --retry-delay 5 "$URL" -o "$TMP/libchdb.tar.gz"

# Verify BEFORE extracting: release assets are mutable even for a fixed tag,
# so this authenticates the download rather than whatever happened to arrive.
ACTUAL_SHA256="$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$TMP/libchdb.tar.gz"; else shasum -a 256 "$TMP/libchdb.tar.gz"; fi | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
	echo "ERROR: libchdb checksum mismatch for $ASSET" >&2
	echo "  expected: $EXPECTED_SHA256" >&2
	echo "  actual:   $ACTUAL_SHA256" >&2
	rm -rf "$TMP"
	exit 1
fi

tar -xzf "$TMP/libchdb.tar.gz" -C "$TMP"
LIB="$(find "$TMP" -name 'libchdb.so' -o -name 'libchdb.dylib' | head -1)"
[ -n "$LIB" ] || { echo "ERROR: libchdb not found in $ASSET" >&2; exit 1; }
cp "$LIB" "$OUT_DIR/libchdb.so"
rm -rf "$TMP"

echo "==> Done. Bundle in $OUT_DIR:"
echo "      maple        ($(du -h "$OUT_DIR/maple" | cut -f1))"
echo "      libchdb.so   ($(du -h "$OUT_DIR/libchdb.so" | cut -f1))"
