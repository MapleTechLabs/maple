#!/bin/sh
# atmn (Autumn CLI) is run through bunx so its ~200 packages stay out of the lockfile.
# autumn.config.ts imports "atmn", so point module resolution at bunx's own install.
set -e
VERSION=1.1.25
bunx "atmn@$VERSION" --version >/dev/null
TMP="${TMPDIR:-/tmp}"
export NODE_PATH="${TMP%/}/bunx-$(id -u)-atmn@$VERSION/node_modules"
exec bunx "atmn@$VERSION" "$@"
