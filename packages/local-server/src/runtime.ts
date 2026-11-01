/// <reference path="./assets.d.ts" />
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, Exit, Option, Schema, Scope } from "effect"
import { FileSystem } from "effect/FileSystem"
import { resolve } from "node:path"
import { DEFAULT_REMOTE_UI_URL, hostedDashboardUrl, hostedUiOrigin, serverUrl } from "./local-address"
import { ChdbError, configureLibchdb, loadedLibchdbRelease } from "./chdb"
import {
	checkpointAvailability,
	reconcileCheckpointRecovery,
	resetLiveStorePreservingCheckpoints,
	resolveChdbConfigFile,
} from "./checkpoints"
import { isMigrationIncomplete, readMigrationJournalStructure } from "./local-store-migration-journal"
import { NO_REMOTE_AUTH } from "./remote-auth"
import { CURRENT_LOCAL_SCHEMA } from "./schema-identity"
import { ensurePortFree, startServer } from "./serve"
import { acquireStoreClaim } from "./store-claim"
import {
	describeError,
	type DirtyStorePolicy,
	LocalStoreDirtyError,
	LocalStoreFromNewerMapleError,
	LocalStoreIncompatibleError,
	LocalStoreMigrationError,
	LocalStoreSchemaStaleError,
	ServerStateError,
	stateFileError,
} from "./store-errors"
import {
	checkStoreCompatible,
	isSchemaIdentityStale,
	isStoreDirty,
	newerStoreSchemaVersion,
} from "./store-version"
import { resolveUiAssets } from "./ui-assets"
import { CHDB_VERSION } from "./version"

/**
 * What to do with a store whose last process was killed before it could close
 * chDB (reopening such a store can crash chDB natively). `"fail"` refuses;
 * `"wipe"` discards its live data, keeping any checkpoints, and starts fresh.
 * Checkpoint restore stays a `maple restore` choice.
 */
export type LocalDirtyStorePolicy = Extract<DirtyStorePolicy, "fail" | "wipe">

export interface LocalOptions {
	readonly dataDir: string
	readonly port?: number
	/** Load libchdb from this path instead of `MAPLE_LIBCHDB` or the default locations. */
	readonly libchdb?: string
	/** Default `"fail"`: an unclean store is never wiped implicitly. */
	readonly onDirtyStore?: LocalDirtyStorePolicy
}

export interface LocalServer {
	readonly port: number
	readonly endpoint: string
	readonly dashboardUrl: string
	readonly dataDir: string
}

const HOSTNAME = "127.0.0.1"

/** Fail closed on any store the CLI would only open after an explicit choice. */
const refuseUnsafeStore = (dataDir: string, onDirtyStore: LocalDirtyStorePolicy) =>
	Effect.gen(function* () {
		const journal = yield* Effect.tryPromise({
			try: () => readMigrationJournalStructure(dataDir),
			catch: (error) =>
				new LocalStoreMigrationError({
					dataDir,
					phase: "read-journal",
					message: describeError(error),
				}),
		})
		if (journal !== null && isMigrationIncomplete(journal.phase))
			return yield* new LocalStoreMigrationError({
				dataDir,
				phase: "resume",
				message: `the local store at ${dataDir} has an unfinished schema migration; resume or abandon it with maple before starting Maple Local`,
			})
		const newerSchema = yield* Effect.try({
			try: () => newerStoreSchemaVersion(dataDir, CURRENT_LOCAL_SCHEMA.version),
			catch: stateFileError(dataDir, "read store schema for"),
		})
		if (newerSchema !== undefined)
			return yield* new LocalStoreFromNewerMapleError({
				dataDir,
				storeSchemaVersion: newerSchema,
				currentSchemaVersion: CURRENT_LOCAL_SCHEMA.version,
				message: `the local store at ${dataDir} was written by a newer maple (schema v${newerSchema}; this build supports up to v${CURRENT_LOCAL_SCHEMA.version}). Nothing was changed.`,
			})
		const compatibility = yield* Effect.try({
			try: () => checkStoreCompatible(dataDir),
			catch: stateFileError(dataDir, "read store identity for"),
		})
		if (!compatibility.compatible)
			return yield* new LocalStoreIncompatibleError({
				dataDir,
				storeBuild: compatibility.found,
				currentBuild: compatibility.current,
				message: `the local store at ${dataDir} is incompatible with this build's chDB (store: ${compatibility.found}; build: ${compatibility.current}). Reset it with maple.`,
			})
		const dirty = yield* Effect.try({
			try: () => isStoreDirty(dataDir),
			catch: stateFileError(dataDir, "read open marker for"),
		})
		if (dirty) {
			if (onDirtyStore === "wipe") {
				yield* Effect.logWarning(
					`the local store at ${dataDir} was not cleanly closed; onDirtyStore is "wipe", so its live data is discarded`,
				)
				yield* resetLiveStorePreservingCheckpoints(dataDir)
			} else {
				const availability = yield* Effect.promise(() => checkpointAvailability(dataDir))
				return yield* new LocalStoreDirtyError({
					dataDir,
					policy: "fail",
					checkpointAvailable: availability.available,
					message:
						`the local store at ${dataDir} was not cleanly closed: the process that owned it was killed before closing chDB, and reopening it can crash chDB. ` +
						`Start with onDirtyStore: "wipe" to discard its live data and start fresh` +
						(availability.available
							? `, or run \`maple restore --data-dir ${dataDir}\` to recover its last checkpoint.`
							: "."),
				})
			}
		}
		const stale = yield* Effect.try({
			try: () => isSchemaIdentityStale(dataDir, CURRENT_LOCAL_SCHEMA),
			catch: stateFileError(dataDir, "read schema identity for"),
		})
		if (stale)
			return yield* new LocalStoreSchemaStaleError({
				dataDir,
				message: `the local store at ${dataDir} has a different schema identity; migrate or reset it with maple`,
			})
	})

/**
 * A build that pinned its chDB release (`__CHDB_VERSION__`) stamps it on every
 * store it writes, so the library actually loaded must be that release: a
 * different one would write stores under a false label and could crash opening
 * them later. Source runs (`"dev"`) carry no pin to check.
 */
const requirePinnedLibchdb = Effect.gen(function* () {
	if (CHDB_VERSION === "dev") return
	const loaded = yield* loadedLibchdbRelease
	if (loaded !== CHDB_VERSION)
		return yield* new ChdbError({
			message: `libchdb ${loaded} is loaded, but this build is pinned to ${CHDB_VERSION}; point MAPLE_LIBCHDB at libchdb ${CHDB_VERSION}`,
		})
})

/** `MAPLE_LOCAL_UI_URL` names a dashboard origin that is not a valid URL. */
export class LocalUiUrlError extends Schema.TaggedError<LocalUiUrlError>()(
	"@maple/local-server/LocalUiUrlError",
	{ rawUrl: Schema.String, message: Schema.String },
) {}

/** The dashboard the server trusts (CORS) and advertises; `maple start` reads the same override. */
const remoteUiUrl = Effect.gen(function* () {
	const configured = yield* Config.option(Config.String("MAPLE_LOCAL_UI_URL")).pipe(
		Effect.map(Option.getOrUndefined),
		Effect.orElseSucceed(() => undefined),
	)
	const url = configured?.trim() || DEFAULT_REMOTE_UI_URL
	return yield* Effect.try({
		try: () => ({ url, origin: hostedUiOrigin(url) }),
		catch: (error) =>
			new LocalUiUrlError({
				rawUrl: url,
				message: `invalid MAPLE_LOCAL_UI_URL: ${describeError(error)}`,
			}),
	})
})

const processState = globalThis as typeof globalThis & { __mapleLocalRuntimeOwner?: string }

/** Acquires into the ambient scope; {@link startLocal} owns that scope's failure path. */
const acquireLocal = (options: LocalOptions) =>
	Effect.gen(function* () {
		const dataDir = resolve(options.dataDir)
		const port = options.port ?? 4318

		// chDB holds process-global native state, even across re-imported modules (HMR).
		yield* Effect.acquireRelease(
			Effect.gen(function* () {
				if (processState.__mapleLocalRuntimeOwner !== undefined)
					return yield* new ServerStateError({
						message: `this process already owns Maple Local at ${processState.__mapleLocalRuntimeOwner}; share that resource instead of opening another chDB store`,
					})
				processState.__mapleLocalRuntimeOwner = dataDir
			}),
			() =>
				Effect.sync(() => {
					delete processState.__mapleLocalRuntimeOwner
				}),
		)
		yield* acquireStoreClaim(
			dataDir,
			(pid) =>
				new ServerStateError({
					message: `the local store at ${dataDir} is already in use${pid === undefined ? "" : ` by PID ${pid}`}`,
				}),
		)
		yield* ensurePortFree(HOSTNAME, port, "the `port` option")
		const ui = yield* remoteUiUrl
		// Per start, never sticky: a retry without `libchdb` falls back to MAPLE_LIBCHDB.
		yield* Effect.acquireRelease(
			Effect.sync(() => configureLibchdb(options.libchdb)),
			() => Effect.sync(() => configureLibchdb(undefined)),
		)
		yield* requirePinnedLibchdb
		yield* reconcileCheckpointRecovery(dataDir)
		yield* refuseUnsafeStore(dataDir, options.onDirtyStore ?? "fail")

		yield* (yield* FileSystem).makeDirectory(dataDir, { recursive: true })
		const { port: boundPort } = yield* startServer({
			hostname: HOSTNAME,
			browserHosts: [HOSTNAME],
			advertiseHost: HOSTNAME,
			corsOrigin: ui.origin,
			port,
			dataDir,
			configFile: yield* resolveChdbConfigFile(dataDir, undefined),
			auth: NO_REMOTE_AUTH,
			assets: yield* resolveUiAssets(),
		})
		return {
			port: boundPort,
			endpoint: serverUrl(HOSTNAME, boundPort),
			dashboardUrl: hostedDashboardUrl(ui.url, boundPort),
			dataDir,
		} satisfies LocalServer
		// Native-host entry point: the caller's Scope still owns all acquired resources.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
	}).pipe(Effect.provide(BunServices.layer))

/**
 * Own one embedded loopback Maple server until the caller's scope closes. No CLI
 * command or Maple executable runs. Unsafe stores fail closed; recovery stays
 * explicit. Periodic checkpoints belong to `maple start`.
 *
 * A failed start releases everything it acquired (process ownership, the PID
 * claim) before failing, even when the caller keeps its scope open: Alchemy
 * retries a failed local resource in the same process without closing it.
 */
export const startLocal = (options: LocalOptions) =>
	Effect.gen(function* () {
		const attempt = yield* Scope.fork(yield* Scope.Scope)
		return yield* acquireLocal(options).pipe(
			Scope.provide(attempt),
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attempt, exit) : Effect.void)),
		)
	})
