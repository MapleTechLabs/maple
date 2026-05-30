import { Context, Effect, Layer, type PlatformError } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as os from "node:os"
import * as path from "node:path"

/**
 * On-disk CLI config, stored at `~/.maple/config.json` (mode 0600). The same
 * `~/.maple` directory holds the local binary's data dir and the extracted
 * query CLI, so everything Maple-local lives in one place.
 */
export interface StoredConfig {
	apiUrl?: string
	token?: string
	orgId?: string
	defaultMode?: "local" | "remote"
}

export const CONFIG_DIR = path.join(os.homedir(), ".maple")
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json")

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:4318"
export const DEFAULT_API_URL = "https://api.maple.dev"

const readStored = (fs: FileSystem): Effect.Effect<StoredConfig> =>
	fs.readFileString(CONFIG_PATH).pipe(
		Effect.flatMap((raw) =>
			Effect.try({
				try: (): StoredConfig => {
					const parsed = JSON.parse(raw) as unknown
					return typeof parsed === "object" && parsed !== null ? (parsed as StoredConfig) : {}
				},
				catch: () => new Error("invalid config"),
			}),
		),
		// Missing/unreadable/invalid file → empty config. The CLI still works in
		// local mode (auto-detect) and `maple login` will create the file.
		Effect.orElseSucceed((): StoredConfig => ({})),
	)

const writeMerged = (
	fs: FileSystem,
	mutate: (cur: StoredConfig) => StoredConfig,
): Effect.Effect<void, PlatformError.PlatformError> =>
	Effect.gen(function* () {
		const merged = mutate(yield* readStored(fs))
		yield* fs.makeDirectory(CONFIG_DIR, { recursive: true })
		yield* fs.writeFileString(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
		// writeFileString's `mode` only applies on create; chmod an existing file
		// too so a token never sits in a world-readable file (best effort).
		yield* fs.chmod(CONFIG_PATH, 0o600).pipe(Effect.ignore)
	})

export interface MapleConfigShape {
	/** Remote API base URL (env `MAPLE_API_URL` overrides the stored value). */
	readonly apiUrl: string | undefined
	/** Remote bearer token (env `MAPLE_API_TOKEN` overrides the stored value). */
	readonly token: string | undefined
	readonly orgId: string | undefined
	/** Local binary base URL (env `MAPLE_LOCAL_URL`, else the default). */
	readonly localUrl: string
	readonly defaultMode: "local" | "remote" | undefined
	/** API URL to use for `maple login` when none is passed. */
	readonly defaultApiUrl: string
	/** Persist config fields (merged with existing). */
	readonly write: (next: StoredConfig) => Effect.Effect<void, PlatformError.PlatformError>
	/** Remove the stored token (used by `maple logout`). */
	readonly clearToken: () => Effect.Effect<void, PlatformError.PlatformError>
}

export class MapleConfig extends Context.Service<MapleConfig, MapleConfigShape>()(
	"@maple/cli/MapleConfig",
	{
		make: Effect.gen(function* () {
			const fs = yield* FileSystem
			const stored = yield* readStored(fs)
			const env = process.env
			return {
				apiUrl: env.MAPLE_API_URL ?? stored.apiUrl,
				token: env.MAPLE_API_TOKEN ?? stored.token,
				orgId: env.MAPLE_ORG_ID ?? stored.orgId,
				localUrl: env.MAPLE_LOCAL_URL ?? DEFAULT_LOCAL_URL,
				defaultMode: stored.defaultMode,
				defaultApiUrl: env.MAPLE_API_URL ?? DEFAULT_API_URL,
				write: (next) => writeMerged(fs, (cur) => ({ ...cur, ...next })),
				clearToken: () =>
					writeMerged(fs, (cur) => {
						const { token: _token, ...rest } = cur
						return rest
					}),
			} satisfies MapleConfigShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
