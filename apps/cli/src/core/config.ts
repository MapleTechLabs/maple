import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
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

const readStored = (): StoredConfig => {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as unknown
		return typeof parsed === "object" && parsed !== null ? (parsed as StoredConfig) : {}
	} catch {
		// Missing/unreadable/invalid file → empty config. The CLI still works in
		// local mode (auto-detect) and `maple login` will create the file.
		return {}
	}
}

const writeMerged = (mutate: (cur: StoredConfig) => StoredConfig): void => {
	const merged = mutate(readStored())
	fs.mkdirSync(CONFIG_DIR, { recursive: true })
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
	// writeFileSync's `mode` only applies on create; chmod an existing file too so
	// a token never sits in a world-readable file.
	try {
		fs.chmodSync(CONFIG_PATH, 0o600)
	} catch {
		/* best effort */
	}
}

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
	readonly write: (next: StoredConfig) => Effect.Effect<void>
	/** Remove the stored token (used by `maple logout`). */
	readonly clearToken: () => Effect.Effect<void>
}

export class MapleConfig extends Context.Service<MapleConfig, MapleConfigShape>()(
	"@maple/cli/MapleConfig",
	{
		make: Effect.sync((): MapleConfigShape => {
			const stored = readStored()
			const env = process.env
			return {
				apiUrl: env.MAPLE_API_URL ?? stored.apiUrl,
				token: env.MAPLE_API_TOKEN ?? stored.token,
				orgId: env.MAPLE_ORG_ID ?? stored.orgId,
				localUrl: env.MAPLE_LOCAL_URL ?? DEFAULT_LOCAL_URL,
				defaultMode: stored.defaultMode,
				defaultApiUrl: env.MAPLE_API_URL ?? DEFAULT_API_URL,
				write: (next) => Effect.sync(() => writeMerged((cur) => ({ ...cur, ...next }))),
				clearToken: () =>
					Effect.sync(() =>
						writeMerged((cur) => {
							const { token: _token, ...rest } = cur
							return rest
						}),
					),
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
