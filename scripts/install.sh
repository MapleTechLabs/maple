#!/bin/sh
# Maple local-binary installer.
#
#   curl -fsSL https://maple.dev/cli/install | sh
#
# (maple.dev/cli/install is this same file, served by apps/landing. The raw
#  GitHub URL — raw.githubusercontent.com/MapleTechLabs/maple/main/scripts/install.sh —
#  works too.)
#
# Downloads the platform bundle from the latest GitHub release, verifies its
# checksum (and the release signature over it, when an OpenSSL 3 is available),
# and installs the 2-file bundle (`maple` + `libchdb.so`) into ~/.maple/bin,
# then puts `maple` on your PATH.
#
# Already installed? `maple update` upgrades in place (same artifact, atomic
# swap) — re-running this installer is only needed for a first install.
#
# The two files MUST stay in the same directory: `maple` (a single Bun-compiled
# binary that does everything — CLI, OTLP-ingest/query server, and UI host)
# dlopens `libchdb.so` via bun:ffi, resolving it relative to its own executable
# path. We install both into ~/.maple/bin and symlink only `maple` onto PATH;
# the binary also falls back to ~/.maple/bin when resolving libchdb, so the
# symlink works regardless of how the path resolves.
#
# Env overrides:
#   MAPLE_VERSION        release tag to install (default: latest)
#   MAPLE_INSTALL_DIR    bundle directory      (default: ~/.maple/bin)
#   MAPLE_BIN_DIR        where `maple` is linked onto PATH (default: first
#                        writable of /usr/local/bin, ~/.local/bin)
#   MAPLE_SKIP_CHECKSUM  set to 1 to skip SHA-256 and signature verification (not recommended)
#   MAPLE_SKIP_SIGNATURE set to 1 to skip only the release signature check (not recommended)
set -eu

REPO="MapleTechLabs/maple"
INSTALL_DIR="${MAPLE_INSTALL_DIR:-$HOME/.maple/bin}"

# Base64 SPKI of the Ed25519 release key: MAPLE_RELEASE_PUBLIC_KEY in
# apps/cli/src/core/release-signature.ts (a test keeps them equal). Empty until
# the key is provisioned, and then signatures are not checked.
release_public_key=""

# RFC 8032 test vector 2 (message "r"). An openssl must verify it before its
# verdict on a real signature counts: LibreSSL (macOS) and FIPS builds cannot.
ed25519_probe_key="MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="
ed25519_probe_sig="kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA=="

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

# download URL DEST MESSAGE — silent fetch with a TTY-aware spinner.
# On a terminal: animate a braille spinner that collapses to ✓ (or ✗ + the curl
# error on failure). Otherwise: print one plain line and fetch quietly. Keeps the
# noisy curl --progress-bar off the screen while still showing progress.
download() {
	_url="$1"
	_dest="$2"
	_msg="$3"
	if [ -t 2 ]; then
		printf '%s ' "$_msg" >&2
		curl -fsSL "$_url" -o "$_dest" 2>"$tmp/curl.err" &
		_pid=$!
		_i=0
		_first=1
		while kill -0 "$_pid" 2>/dev/null; do
			case "$_i" in
				0) _f='⠋' ;; 1) _f='⠙' ;; 2) _f='⠹' ;; 3) _f='⠸' ;; 4) _f='⠼' ;;
				5) _f='⠴' ;; 6) _f='⠦' ;; 7) _f='⠧' ;; 8) _f='⠇' ;; 9) _f='⠏' ;;
			esac
			if [ "$_first" = 1 ]; then _first=0; else printf '\b' >&2; fi
			printf '%s' "$_f" >&2
			_i=$(((_i + 1) % 10))
			sleep 0.08
		done
		if wait "$_pid"; then
			printf '\b✓\n' >&2
		else
			printf '\b✗\n' >&2
			[ -s "$tmp/curl.err" ] && cat "$tmp/curl.err" >&2
			return 1
		fi
	else
		printf '%s\n' "$_msg" >&2
		curl -fsSL "$_url" -o "$_dest"
	fi
}

# ed25519_verify OPENSSL SPKI_B64 DATA_FILE SIG_B64_FILE: exit 0 iff the base64
# signature in SIG_B64_FILE is valid over DATA_FILE's exact bytes.
ed25519_verify() {
	printf '%s\n' '-----BEGIN PUBLIC KEY-----' "$2" '-----END PUBLIC KEY-----' >"$tmp/ed25519.pem"
	"$1" base64 -d -A -in "$4" -out "$tmp/ed25519.sig" >/dev/null 2>&1 || return 1
	"$1" pkeyutl -verify -pubin -inkey "$tmp/ed25519.pem" -rawin \
		-in "$3" -sigfile "$tmp/ed25519.sig" >/dev/null 2>&1
}

# Print the first openssl that passes the Ed25519 self-test. Homebrew's
# openssl@3 is keg-only, so its usual prefixes are tried after PATH.
find_ed25519_openssl() {
	printf 'r' >"$tmp/probe.msg"
	printf '%s\n' "$ed25519_probe_sig" >"$tmp/probe.sig"
	for _ossl in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
		case "$_ossl" in
			/*) [ -x "$_ossl" ] || continue ;;
			*) command -v "$_ossl" >/dev/null 2>&1 || continue ;;
		esac
		if ed25519_verify "$_ossl" "$ed25519_probe_key" "$tmp/probe.msg" "$tmp/probe.sig"; then
			printf '%s\n' "$_ossl"
			return 0
		fi
	done
	return 1
}

# Authenticate $tmp/bundle.sha256 before its checksum is trusted. The signed
# manifest must name this exact bundle, so one signed for another version or
# platform cannot vouch for this download.
verify_signature() {
	[ -n "$release_public_key" ] || return 0
	if [ "${MAPLE_SKIP_SIGNATURE:-0}" = "1" ]; then
		say "Skipping signature verification (MAPLE_SKIP_SIGNATURE=1)."
		return 0
	fi
	if ! ossl="$(find_ed25519_openssl)"; then
		say "note: release signature not checked (needs OpenSSL 3); to verify by hand see https://github.com/$REPO/blob/main/docs/local-mode.md#release-signing"
		return 0
	fi
	curl -fsSL "${url}.sha256.sig" -o "$tmp/bundle.sha256.sig" \
		|| die "could not fetch the release signature (${url}.sha256.sig). Set MAPLE_SKIP_SIGNATURE=1 to install without it."
	ed25519_verify "$ossl" "$release_public_key" "$tmp/bundle.sha256" "$tmp/bundle.sha256.sig" \
		|| die "release signature is invalid for ${name}.tar.gz; refusing to install. Set MAPLE_SKIP_SIGNATURE=1 to override."
	signed_name="$(awk 'NR == 1 { print $2 }' "$tmp/bundle.sha256")"
	[ "${signed_name#\*}" = "${name}.tar.gz" ] \
		|| die "the signed checksum is for '${signed_name}', not ${name}.tar.gz; refusing to install."
	say "Signature verified."
}

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
download "$url" "$tmp/bundle.tar.gz" "Downloading Maple ${tag} (${target})…" \
	|| die "download failed: $url"

# The release workflow always publishes a `.sha256` alongside each bundle, so a
# missing one means a network/mirror problem or tampering — fail loudly rather
# than installing an unverified binary. `MAPLE_SKIP_CHECKSUM=1` is the escape
# hatch for air-gapped mirrors that don't carry the checksum file.
if [ "${MAPLE_SKIP_CHECKSUM:-0}" = "1" ]; then
	say "Skipping checksum verification (MAPLE_SKIP_CHECKSUM=1)."
else
	curl -fsSL "${url}.sha256" -o "$tmp/bundle.sha256" \
		|| die "could not fetch checksum (${url}.sha256). Set MAPLE_SKIP_CHECKSUM=1 to bypass."
	verify_signature
	expected="$(awk 'NR == 1 {print $1}' "$tmp/bundle.sha256")"
	if command -v shasum >/dev/null 2>&1; then
		actual="$(shasum -a 256 "$tmp/bundle.tar.gz" | awk '{print $1}')"
	else
		actual="$(sha256sum "$tmp/bundle.tar.gz" | awk '{print $1}')"
	fi
	[ "$expected" = "$actual" ] || die "checksum mismatch (expected $expected, got $actual)"
	say "Checksum verified."
fi

# --- install the 2-file bundle ------------------------------------------------
tar -xzf "$tmp/bundle.tar.gz" -C "$tmp"
[ -d "$tmp/$name" ] || die "unexpected archive layout (no $name/ directory)"

mkdir -p "$INSTALL_DIR"
cp "$tmp/$name/maple" "$tmp/$name/libchdb.so" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/maple"

# macOS: clear the Gatekeeper quarantine flag set on downloaded files.
if [ "$os" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
	xattr -dr com.apple.quarantine "$INSTALL_DIR/maple" "$INSTALL_DIR/libchdb.so" 2>/dev/null || true
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
say "✓ Installed to $INSTALL_DIR (maple + libchdb.so)"
say "✓ Linked $link_dir/maple"
case ":$PATH:" in
	*":$link_dir:"*) ;;
	*) say "" ; say "  $link_dir is not on your PATH yet — add:" ; say "    export PATH=\"$link_dir:\$PATH\"" ;;
esac
say ""
say "Get started:"
say "  maple start                 # OTLP ingest + embedded ClickHouse + UI on :4318"
say "  maple services              # query the running server"
say "  maple traces"
