#!/usr/bin/env bash
# Build the distributable `maple` local binary — a single Bun-compiled
# executable plus libchdb. No Rust/cargo involved.
#
# Pipeline:
#   1. Build the workspace packages consumed through gitignored `dist/` paths.
#   2. Build the lightweight SPA (`apps/local-ui` → its `dist/`).
#   3. Inline that dist into apps/cli/src/server/ui-embed.gen.ts so
#      `bun build --compile` bakes the SPA into the binary.
#   4. Compile apps/cli (the CLI + the OTLP-ingest/query server) into a single
#      executable with `bun build --compile`. The schema artifacts and SPA are
#      embedded; the OTLP encoders run in-process; chDB is reached via bun:ffi.
#   5. Download libchdb (v26.7.3, matching what we test against) for the host
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
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
LIBCHDB_VERSION="${LIBCHDB_VERSION:-v26.7.3}"
UI_EMBED="$REPO_ROOT/apps/cli/src/server/ui-embed.gen.ts"

# Version baked into the binary via `bun build --define`. The release workflow
# passes the tag; a local build defaults to `git describe` (or "dev").
MAPLE_BUILD_VERSION="${MAPLE_BUILD_VERSION:-$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo dev)}"

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
	--outfile "$OUT_DIR/maple" )

echo "==> Downloading libchdb $LIBCHDB_VERSION for this platform"
case "$(uname -s)-$(uname -m)" in
	Linux-x86_64)        ASSET="linux-x86_64-libchdb.tar.gz" ;;
	Linux-aarch64)       ASSET="linux-aarch64-libchdb.tar.gz" ;;
	Darwin-x86_64)       ASSET="macos-x86_64-libchdb.tar.gz" ;;
	Darwin-arm64)        ASSET="macos-arm64-libchdb.tar.gz" ;;
	*) echo "ERROR: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
# Expected sha256 per (LIBCHDB_VERSION, platform asset): release assets are
# mutable even for a fixed tag, so this is verified before extraction. Bumping
# LIBCHDB_VERSION means adding each asset's hash here. A `case` rather than an
# associative array because macOS still ships bash 3.2.
# v26.1.0's macos-arm64 dylib put its LINKEDIT string pool at a non-8-byte-aligned
# offset, which newer dyld rejects ("mis-aligned LINKEDIT string pool"). Check
# `otool -l libchdb.so` (LC_SYMTAB stroff % 8 == 0) before pinning a new release.
case "$LIBCHDB_VERSION/$ASSET" in
	v26.7.3/linux-x86_64-libchdb.tar.gz)  EXPECTED_SHA256="bc33260c32acf78eade2ac41a9115f38e00404651fa42e3bb4c419e4f011c031" ;;
	v26.7.3/linux-aarch64-libchdb.tar.gz) EXPECTED_SHA256="d153adad1ff39b2e3caf0417f09d8bd9edd41939c7c67a3c4978a61e73fb9227" ;;
	v26.7.3/macos-x86_64-libchdb.tar.gz)  EXPECTED_SHA256="af5ded3ed3e84c31af1cd198dcf459f11d2b6aad4f6ddeccc04b8a519b0300fc" ;;
	v26.7.3/macos-arm64-libchdb.tar.gz)   EXPECTED_SHA256="5640e50dccf711bf3dd5551333d08e43f433edf7bd94b2289f36c2539e627762" ;;
	*) echo "ERROR: no pinned sha256 for $ASSET at LIBCHDB_VERSION=$LIBCHDB_VERSION" >&2; exit 1 ;;
esac

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
