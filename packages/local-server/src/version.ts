// Build-time version string. `scripts/build-local-binary.sh` bakes the real
// release tag in via `bun build --define '__MAPLE_VERSION__="v1.2.3"'`, so a
// compiled `maple --version` reports exactly the release it was built from.
//
// `typeof` guards the reference so an un-defined identifier (the dev path,
// `bun run src/bin.ts`, where no --define is passed) reports "dev" instead of
// throwing a ReferenceError.
declare const __MAPLE_VERSION__: string | undefined

const raw = typeof __MAPLE_VERSION__ !== "undefined" ? __MAPLE_VERSION__ : "dev"

// The CLI framework prints "<name> v<version>", so strip a leading "v" from
// release tags like "v0.5.0" to avoid a doubled "vv0.5.0".
export const MAPLE_VERSION: string = raw.replace(/^v/, "")

// The libchdb release the binary was built against (e.g. "v26.1.0"), baked in by
// `scripts/build-local-binary.sh` via `bun build --define`. It identifies the
// chDB on-disk-store format, so the store-version guard can refuse a directory
// written by an incompatible build. Dev runs (`bun run src/bin.ts`, no --define)
// report "dev".
declare const __CHDB_VERSION__: string | undefined

export const CHDB_VERSION: string = typeof __CHDB_VERSION__ !== "undefined" ? __CHDB_VERSION__ : "dev"
