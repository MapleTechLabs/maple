#!/bin/sh
# Maple local-binary installer.
#
#   curl -fsSL https://maple.dev/cli/install | sh
#
# (maple.dev/cli/install is this same file, served by apps/landing. The raw
#  GitHub URL — raw.githubusercontent.com/Makisuo/maple/main/scripts/install.sh —
#  works too.)
#
# Downloads the platform bundle from the latest GitHub release, verifies its
# checksum, and installs the 3-file bundle (`maple` + `libchdb.so` + `maple-cli`)
# into ~/.maple/bin, then puts `maple` on your PATH.
#
# The three files MUST stay in the same directory: the `maple` binary finds
# `libchdb.so` via a relative rpath (@loader_path / $ORIGIN) and forwards every
# subcommand other than `start` to the sibling `maple-cli`. We install all three
# together and symlink only `maple` onto PATH — `current_exe()` resolves the
# symlink to the real directory, so the siblings are still found.
#
# Env overrides:
#   MAPLE_VERSION      release tag to install (default: latest)
#   MAPLE_INSTALL_DIR  bundle directory      (default: ~/.maple/bin)
#   MAPLE_BIN_DIR      where `maple` is linked onto PATH (default: first
#                      writable of /usr/local/bin, ~/.local/bin)
set -eu

REPO="Makisuo/maple"
INSTALL_DIR="${MAPLE_INSTALL_DIR:-$HOME/.maple/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

need curl
need tar
need uname

# --- detect platform → release target ----------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
	Darwin)
		case "$arch" in
			arm64 | aarch64) target="aarch64-apple-darwin" ;;
			x86_64) target="x86_64-apple-darwin" ;;
			*) die "unsupported macOS architecture: $arch" ;;
		esac
		;;
	Linux)
		case "$arch" in
			x86_64 | amd64) target="x86_64-unknown-linux-gnu" ;;
			arm64 | aarch64) target="aarch64-unknown-linux-gnu" ;;
			*) die "unsupported Linux architecture: $arch" ;;
		esac
		;;
	*) die "unsupported OS: $os (Maple ships macOS and Linux bundles)" ;;
esac

# --- resolve release tag ------------------------------------------------------
tag="${MAPLE_VERSION:-}"
if [ -z "$tag" ]; then
	# Use -sS (not -f) so a 404 "no releases yet" doesn't print a confusing
	# curl error — we give our own clear message below.
	tag="$(curl -sSL "https://api.github.com/repos/$REPO/releases/latest" \
		| sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$tag" ] || die "no release found for $REPO — check https://github.com/$REPO/releases or set MAPLE_VERSION to pin a tag"

name="maple-${tag}-${target}"
url="https://github.com/$REPO/releases/download/${tag}/${name}.tar.gz"

say "Installing Maple ${tag} (${target})…"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- download + verify --------------------------------------------------------
curl -fSL --progress-bar "$url" -o "$tmp/bundle.tar.gz" \
	|| die "download failed: $url"

if curl -fsSL "${url}.sha256" -o "$tmp/bundle.sha256" 2>/dev/null; then
	expected="$(awk '{print $1}' "$tmp/bundle.sha256")"
	if command -v shasum >/dev/null 2>&1; then
		actual="$(shasum -a 256 "$tmp/bundle.tar.gz" | awk '{print $1}')"
	else
		actual="$(sha256sum "$tmp/bundle.tar.gz" | awk '{print $1}')"
	fi
	[ "$expected" = "$actual" ] || die "checksum mismatch (expected $expected, got $actual)"
	say "Checksum verified."
fi

# --- install the 3-file bundle ------------------------------------------------
tar -xzf "$tmp/bundle.tar.gz" -C "$tmp"
[ -d "$tmp/$name" ] || die "unexpected archive layout (no $name/ directory)"

mkdir -p "$INSTALL_DIR"
cp "$tmp/$name/maple" "$tmp/$name/maple-cli" "$tmp/$name/libchdb.so" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/maple" "$INSTALL_DIR/maple-cli"

# macOS: clear the Gatekeeper quarantine flag set on downloaded files.
if [ "$os" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
	xattr -dr com.apple.quarantine "$INSTALL_DIR/maple" "$INSTALL_DIR/maple-cli" "$INSTALL_DIR/libchdb.so" 2>/dev/null || true
fi

# --- put `maple` on PATH ------------------------------------------------------
link_dir="${MAPLE_BIN_DIR:-}"
if [ -z "$link_dir" ]; then
	for d in /usr/local/bin "$HOME/.local/bin"; do
		if [ -d "$d" ] && [ -w "$d" ]; then link_dir="$d"; break; fi
	done
	# Fall back to ~/.local/bin (create it) if nothing writable was found.
	[ -n "$link_dir" ] || link_dir="$HOME/.local/bin"
fi
mkdir -p "$link_dir"
ln -sf "$INSTALL_DIR/maple" "$link_dir/maple"

say ""
say "✓ Installed to $INSTALL_DIR"
say "✓ Linked  $link_dir/maple"
case ":$PATH:" in
	*":$link_dir:"*) ;;
	*) say "" ; say "  $link_dir is not on your PATH yet — add:" ; say "    export PATH=\"$link_dir:\$PATH\"" ;;
esac
say ""
say "Get started:"
say "  maple start                 # OTLP ingest + embedded ClickHouse + UI on :4318"
say "  maple services              # query the running server"
say "  maple traces"
