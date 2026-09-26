import { Clock, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as os from "node:os"
import * as path from "node:path"
import { defaultLocalUrl } from "../lib/local-address"
import { durableWrite } from "../server/durable-files"
import {
	credentialAccount,
	deleteNativeCredential,
	readNativeCredential,
	writeNativeCredential,
} from "./credential-store"

/**
 * On-disk CLI config, stored at `~/.maple/config.json` (mode 0600). The same
 * `~/.maple` directory holds the local binary's data dir and the extracted
 * query CLI, so everything Maple-local lives in one place.
 */
export interface StoredConfig {
	apiUrl?: string
	token?: string
	orgId?: string
	userId?: string
	credentialStore?: "keychain" | "file"
	credentialManaged?: boolean
	defaultMode?: "local" | "remote"
	/** ISO timestamp of the last startup update check (throttles the GitHub probe). */
	lastUpdateCheck?: string
	/** Latest release tag seen by the update check (e.g. "v0.6.0"), cached so the
	 *  notice can render between probes without hitting the network. */
	latestKnownVersion?: string
}

/** The config file exists but cannot be read, parsed, or replaced. Names the
 *  path so the user can repair or remove it. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("@maple/cli/ConfigFileError", {
	message: Schema.String,
	path: Schema.String,
}) {}

const CONFIG_DIR = path.join(os.homedir(), ".maple")
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json")

const DEFAULT_API_URL = "https://api.maple.dev"

const StoredConfigFields = Schema.Struct({
	apiUrl: Schema.optionalKey(Schema.String),
	token: Schema.optionalKey(Schema.String),
	orgId: Schema.optionalKey(Schema.String),
	userId: Schema.optionalKey(Schema.String),
	credentialStore: Schema.optionalKey(Schema.Literals(["keychain", "file"])),
	credentialManaged: Schema.optionalKey(Schema.Boolean),
	defaultMode: Schema.optionalKey(Schema.Literals(["local", "remote"])),
	lastUpdateCheck: Schema.optionalKey(Schema.String),
	latestKnownVersion: Schema.optionalKey(Schema.String),
})
const KNOWN_KEYS = new Set(Object.keys(StoredConfigFields.fields))
const decodeConfigObject = Schema.decodeUnknownResult(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodeStoredConfig = Schema.decodeUnknownResult(StoredConfigFields)

interface ConfigFile {
	readonly config: StoredConfig
	/** Keys another CLI version wrote; carried over untouched on write. */
	readonly unknownFields: Readonly<Record<string, unknown>>
}

const readConfig = (fs: FileSystem, configPath: string): Effect.Effect<ConfigFile, ConfigFileError> =>
	fs.readFileString(configPath).pipe(
		Effect.map(Option.some),
		Effect.catchTag("PlatformError", (error) =>
			error.reason._tag === "NotFound"
				? Effect.succeed(Option.none<string>())
				: Effect.fail(
						new ConfigFileError({ path: configPath, message: `cannot read ${configPath}` }),
					),
		),
		Effect.flatMap((raw) => {
			if (Option.isNone(raw)) return Effect.succeed<ConfigFile>({ config: {}, unknownFields: {} })
			const invalid = new ConfigFileError({
				path: configPath,
				message: `${configPath} is not a valid Maple config; fix or remove it`,
			})
			const object = decodeConfigObject(raw.value)
			if (Result.isFailure(object)) return Effect.fail(invalid)
			const config = decodeStoredConfig(object.success)
			if (Result.isFailure(config)) return Effect.fail(invalid)
			const unknownFields = Object.fromEntries(
				Object.entries(object.success).filter(([key]) => !KNOWN_KEYS.has(key)),
			)
			return Effect.succeed<ConfigFile>({ config: config.success, unknownFields })
		}),
	)

/** Read the config at `configPath`. A missing file is an empty config; an
 *  unreadable or malformed one is an error, never silently `{}`. */
export const readConfigFile = (
	fs: FileSystem,
	configPath: string,
): Effect.Effect<StoredConfig, ConfigFileError> =>
	readConfig(fs, configPath).pipe(Effect.map((file) => file.config))

/** Merge into the config at `configPath` through a temp file + fsync + rename,
 *  so a crash or full disk leaves the previous file (and its token) intact. */
export const writeConfigFile = (
	fs: FileSystem,
	configPath: string,
	mutate: (cur: StoredConfig) => StoredConfig,
): Effect.Effect<void, ConfigFileError> =>
	Effect.gen(function* () {
		const current = yield* readConfig(fs, configPath)
		const merged = { ...current.unknownFields, ...mutate(current.config) }
		yield* Effect.tryPromise({
			try: () => durableWrite(configPath, `${JSON.stringify(merged, null, 2)}\n`),
			catch: (cause) =>
				new ConfigFileError({
					path: configPath,
					message: `cannot write ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
				}),
		})
	})

const writeMerged = (fs: FileSystem, mutate: (cur: StoredConfig) => StoredConfig) =>
	writeConfigFile(fs, CONFIG_PATH, mutate)

const sameCredentialOrigin = (left: string, right: string): boolean => {
	const origins = Result.try(() => [credentialAccount(left), credentialAccount(right)] as const)
	return Result.isSuccess(origins) && origins.success[0] === origins.success[1]
}

/** A file-stored token belongs to the API it was issued by; a different
 *  `MAPLE_API_URL` must not receive it. */
export const storedTokenFor = (stored: StoredConfig, apiUrl: string | undefined): string | undefined =>
	stored.token !== undefined &&
	stored.apiUrl !== undefined &&
	apiUrl !== undefined &&
	sameCredentialOrigin(stored.apiUrl, apiUrl)
		? stored.token
		: undefined

export interface MapleConfigValues {
	/** Remote API base URL (env `MAPLE_API_URL` overrides the stored value). */
	readonly apiUrl: Option.Option<string>
	/** Remote bearer token (env `MAPLE_API_TOKEN` overrides the stored value). */
	readonly token: Option.Option<Redacted.Redacted<string>>
	readonly orgId: Option.Option<string>
	readonly userId: Option.Option<string>
	readonly credentialStore: Option.Option<"keychain" | "file">
	readonly credentialManaged: boolean
	readonly tokenSource: "env" | "keychain" | "file" | "none"
	readonly envTokenOverride: boolean
	/** Local binary base URL (env `MAPLE_LOCAL_URL`, else the default). */
	readonly localUrl: string
	readonly defaultMode: Option.Option<"local" | "remote">
	/** API URL to use for `maple login` when none is passed. */
	readonly defaultApiUrl: string
	/** ISO timestamp of the last startup update check (`None` = never checked). */
	readonly lastUpdateCheck: Option.Option<string>
	/** Latest release tag seen by the last update check, or `None`. */
	readonly latestKnownVersion: Option.Option<string>
	/** Persist config fields (merged with existing). */
	readonly write: (next: StoredConfig) => Effect.Effect<void, ConfigFileError>
	readonly saveRemoteCredential: (next: {
		readonly apiUrl: string
		readonly token: string
		readonly orgId: string
		readonly userId: string
		readonly managed: boolean
	}) => Effect.Effect<"keychain" | "file", ConfigFileError>
	readonly clearRemoteCredential: () => Effect.Effect<void, ConfigFileError>
	/** Pin the default mode (used by `maple use local|remote`). */
	readonly setDefaultMode: (mode: "local" | "remote") => Effect.Effect<void, ConfigFileError>
	/** Drop the pinned default mode, reverting to auto-detect (`maple use auto`). */
	readonly clearDefaultMode: () => Effect.Effect<void, ConfigFileError>
	/** Stamp the update-check timestamp (always) and the latest seen tag (when
	 *  provided — omitted on a failed probe so the cached version is preserved). */
	readonly recordUpdateCheck: (latestTag?: string) => Effect.Effect<void, ConfigFileError>
}

export class MapleConfig extends Context.Service<MapleConfig, MapleConfigValues>()("@maple/cli/MapleConfig", {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem
		// The native credential helpers spawn `security`/`secret-tool`. Capturing
		// the spawner here keeps it out of MapleConfigValues' signatures, the same
		// way `fs` is captured for the write helpers.
		const spawner = yield* ChildProcessSpawner
		const keychain = <A>(effect: Effect.Effect<A, never, ChildProcessSpawner>): Effect.Effect<A> =>
			Effect.provideService(effect, ChildProcessSpawner, spawner)
		// An unreadable config still lets local mode run; writes refuse to merge over it.
		const stored = yield* readConfigFile(fs, CONFIG_PATH).pipe(
			Effect.catchTag("@maple/cli/ConfigFileError", (error) =>
				Effect.logWarning(error.message).pipe(Effect.as<StoredConfig>({})),
			),
		)
		const env = process.env
		const resolvedApiUrl = env.MAPLE_API_URL ?? stored.apiUrl
		const envToken = env.MAPLE_API_TOKEN
		const fileToken = storedTokenFor(stored, resolvedApiUrl)
		const nativeToken =
			!envToken && !fileToken && stored.credentialStore === "keychain" && resolvedApiUrl
				? yield* keychain(readNativeCredential(resolvedApiUrl))
				: undefined
		const resolvedToken = envToken ?? fileToken ?? nativeToken
		const tokenSource = envToken
			? ("env" as const)
			: fileToken
				? ("file" as const)
				: nativeToken
					? ("keychain" as const)
					: ("none" as const)
		return {
			apiUrl: Option.fromNullishOr(resolvedApiUrl),
			token: Option.map(Option.fromNullishOr(resolvedToken), Redacted.make),
			orgId: Option.fromNullishOr(env.MAPLE_ORG_ID ?? stored.orgId),
			userId: Option.fromNullishOr(stored.userId),
			credentialStore: Option.fromNullishOr(stored.credentialStore),
			credentialManaged: stored.credentialManaged === true,
			tokenSource,
			envTokenOverride: envToken !== undefined,
			localUrl: env.MAPLE_LOCAL_URL ?? defaultLocalUrl(env.MAPLE_LOCAL_BIND_HOST),
			defaultMode: Option.fromNullishOr(stored.defaultMode),
			defaultApiUrl: env.MAPLE_API_URL ?? DEFAULT_API_URL,
			lastUpdateCheck: Option.fromNullishOr(stored.lastUpdateCheck),
			latestKnownVersion: Option.fromNullishOr(stored.latestKnownVersion),
			write: (next) => writeMerged(fs, (cur) => ({ ...cur, ...next })),
			saveRemoteCredential: (next) =>
				Effect.gen(function* () {
					const storedInKeychain = yield* keychain(writeNativeCredential(next.apiUrl, next.token))
					if (!storedInKeychain) {
						yield* keychain(deleteNativeCredential(next.apiUrl))
					}
					yield* writeMerged(fs, (cur) => {
						const { token: _token, ...withoutToken } = cur
						return {
							...withoutToken,
							apiUrl: next.apiUrl,
							orgId: next.orgId,
							userId: next.userId,
							credentialManaged: next.managed,
							credentialStore: storedInKeychain ? "keychain" : "file",
							...(!storedInKeychain ? { token: next.token } : undefined),
						}
					})
					return storedInKeychain ? "keychain" : "file"
				}),
			clearRemoteCredential: () =>
				Effect.gen(function* () {
					const storedApiUrl = stored.apiUrl
					if (storedApiUrl && stored.credentialStore === "keychain") {
						yield* keychain(deleteNativeCredential(storedApiUrl))
					}
					yield* writeMerged(fs, (cur) => {
						const {
							token: _token,
							apiUrl: _apiUrl,
							orgId: _orgId,
							userId: _userId,
							credentialStore: _store,
							credentialManaged: _managed,
							...rest
						} = cur
						return rest
					})
				}),
			setDefaultMode: (mode) => writeMerged(fs, (cur) => ({ ...cur, defaultMode: mode })),
			clearDefaultMode: () =>
				writeMerged(fs, (cur) => {
					const { defaultMode: _mode, ...rest } = cur
					return rest
				}),
			recordUpdateCheck: (latestTag) =>
				Effect.gen(function* () {
					const nowIso = new Date(yield* Clock.currentTimeMillis).toISOString()
					yield* writeMerged(fs, (cur) => ({
						...cur,
						lastUpdateCheck: nowIso,
						...(latestTag ? { latestKnownVersion: latestTag } : undefined),
					}))
				}),
		} satisfies MapleConfigValues
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
