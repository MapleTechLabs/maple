#!/usr/bin/env bash
# Point nix/release.json (the flake's `maple` package) at a published release:
# reads each bundle's `.sha256` asset, so nothing is downloaded but checksums.
# A platform is pinned only when both its bundle and checksum finished uploading;
# one missing from the release is left out, and any gh failure aborts.
#
# Usage: scripts/update-nix-release.sh v0.3.6
set -euo pipefail

TAG="${1:?usage: $0 <tag, e.g. v0.3.6>}"
TAG="v${TAG#v}"
REPO="${REPO:-MapleTechLabs/maple}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/nix/release.json"

uploaded="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[] | select(.state == "uploaded") | .name')"

assets=""
for pair in x86_64-linux:x86_64-unknown-linux-gnu aarch64-linux:aarch64-unknown-linux-gnu \
	x86_64-darwin:x86_64-apple-darwin aarch64-darwin:aarch64-apple-darwin; do
	system="${pair%%:*}"
	target="${pair#*:}"
	name="maple-${TAG}-${target}.tar.gz"
	if ! grep -Fqx "$name" <<<"$uploaded" || ! grep -Fqx "$name.sha256" <<<"$uploaded"; then
		echo "warning: $TAG has no complete $name, leaving $system out" >&2
		continue
	fi
	line="$(gh release download "$TAG" --repo "$REPO" --pattern "${name}.sha256" --output -)"
	hash="${line%% *}"
	[[ "$hash" =~ ^[0-9a-f]{64}$ ]] || { echo "error: bad checksum line for $name: $line" >&2; exit 1; }
	assets+="$(printf '"%s":{"target":"%s","sha256":"%s"},' "$system" "$target" "$hash")"
done

# NixOS hosts are Linux: a release without both Linux bundles is not worth pinning.
for system in x86_64-linux aarch64-linux; do
	[[ "$assets" == *"\"$system\""* ]] || { echo "error: $TAG has no $system bundle" >&2; exit 1; }
done
printf '{"version":"%s","assets":{%s}}' "${TAG#v}" "${assets%,}" | jq --tab . > "$OUT"
echo "nix/release.json -> ${TAG}"
