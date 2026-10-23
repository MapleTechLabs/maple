#!/usr/bin/env bash
# Build the self-hosted image from this checkout: cross-compile a Linux bundle
# per platform, assemble the build context, and build. One platform is loaded
# into the local Docker; several need EXTRA_ARGS=--push (or another output).
# BUNDLES=<dir> skips the compile and takes <dir>/linux-<arch>/{maple,libchdb.so}.
#
# Usage: apps/cli/docker/build-image.sh <tag> [platforms]
#   apps/cli/docker/build-image.sh maple-local:dev
#   EXTRA_ARGS=--push apps/cli/docker/build-image.sh ghcr.io/me/maple:dev linux/amd64,linux/arm64
set -euo pipefail

TAG="${1:?usage: build-image.sh <tag> [platforms]}"
PLATFORMS="${2:-linux/$(docker version --format '{{.Server.Arch}}')}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/maple-image.XXXXXX")"
trap 'rm -rf "$CONTEXT"' EXIT

IFS=',' read -r -a platform_list <<<"$PLATFORMS"
for platform in "${platform_list[@]}"; do
	arch="${platform#linux/}"
	case "$arch" in
		amd64) target="linux-x64" ;;
		arm64) target="linux-arm64" ;;
		*) echo "ERROR: unsupported platform $platform" >&2; exit 1 ;;
	esac
	if [[ -n "${BUNDLES:-}" ]]; then
		mkdir -p "$CONTEXT/linux-$arch"
		cp "$BUNDLES/linux-$arch/maple" "$BUNDLES/linux-$arch/libchdb.so" "$CONTEXT/linux-$arch/"
	else
		OUT_DIR="$CONTEXT/linux-$arch" MAPLE_TARGET="$target" "$REPO_ROOT/scripts/build-local-binary.sh"
	fi
done
cp "$HERE/Dockerfile" "$HERE/entrypoint.sh" "$CONTEXT/"

output=()
if [[ "${#platform_list[@]}" == 1 && -z "${EXTRA_ARGS:-}" ]]; then
	output=(--load)
fi
# shellcheck disable=SC2086 # EXTRA_ARGS is a list of flags
docker buildx build --platform "$PLATFORMS" --tag "$TAG" ${output[@]+"${output[@]}"} ${EXTRA_ARGS:-} "$CONTEXT"
