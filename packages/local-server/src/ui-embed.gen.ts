// Generated at build time by scripts/build-local-binary.sh (it base64-inlines
// every file from apps/local-ui/dist into this module so `bun build --compile`
// bakes the SPA into the `maple` binary).
//
// This committed version is the DEV STUB: `undefined` means "no embedded SPA",
// so the server falls back to serving apps/local-ui/dist from disk.
export interface EmbeddedAsset {
	readonly data: Uint8Array
	readonly contentType: string
}

export const embeddedAssets: ReadonlyMap<string, EmbeddedAsset> | undefined = undefined
