/// <reference path="./assets.d.ts" />
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Duration, Effect, Exit, Option, Schedule, Schema, Scope } from "effect"
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
import { readDiscovery, removeDiscoveryFor, type ServerDiscovery, writeDiscovery } from "./server-discovery"
import { acquireStoreClaim, locatePidFile, pidOwner } from "./store-claim"
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
	serverDiscoveryPath,
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
	/** Bind exactly this port, failing when it is taken. Unset: 4318, or any free port when 4318 is taken. */
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
	/** The PID serving this store when another process owns it (a second `alchemy dev`). */
	readonly sharedWith?: number
}

const HOSTNAME = "127.0.0.1"
const DEFAULT_PORT = 4318

/** Another live process owns the store. */
export class LocalStoreBusyError extends Schema.TaggedError<LocalStoreBusyError>()(
	"@maple/local-server/LocalStoreBusyError",
	{ dataDir: Schema.String, pid: Schema.UndefinedOr(Schema.Int), message: Schema.String },
) {}

const storeBusy = (dataDir: string) => (pid: number | undefined) =>
	new LocalStoreBusyError({
		dataDir,
		pid,
		message: `the local store at ${dataDir} is already in use${pid === undefined ? "" : ` by PID ${pid}`}`,
	})

/** `port` is what to try first; `strict` refuses a fallback to a free one. */
interface PortChoice {
	readonly port: number
	readonly strict: boolean
}

const bindablePort = ({ port, strict }: PortChoice) =>
	strict
		? ensurePortFree(HOSTNAME, port, "the `port` option").pipe(Effect.as(port))
		: ensurePortFree(HOSTNAME, port).pipe(
				Effect.as(port),
				Effect.catchTag("@maple/cli/ServerBindError", () =>
					Effect.logInfo(`port ${port} is in use; Maple Local takes a free port instead`).pipe(
						Effect.as(0),
					),
				),
			)

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
const acquireLocal = (options: LocalOptions, portChoice: PortChoice) =>
	Effect.gen(function* () {
		const dataDir = resolve(options.dataDir)

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
		yield* acquireStoreClaim(dataDir, storeBusy(dataDir))
		const port = yield* bindablePort(portChoice)
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
		const endpoint = serverUrl(HOSTNAME, boundPort)
		// How a second `alchemy dev` of the same stack finds this server (and `maple status` too).
		const discoveryPath = serverDiscoveryPath(dataDir)
		yield* Effect.acquireRelease(
			writeDiscovery(discoveryPath, {
				pid: process.pid,
				url: endpoint,
				dataDir,
				startedAt: new Date().toISOString(),
			}),
			() => removeDiscoveryFor(discoveryPath, process.pid),
		)
		return {
			port: boundPort,
			endpoint,
			dashboardUrl: hostedDashboardUrl(ui.url, boundPort),
			dataDir,
		} satisfies LocalServer
		// Native-host entry point: the caller's Scope still owns all acquired resources.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
	}).pipe(Effect.provide(BunServices.layer))

/** The live process holding the store's claim, if any. */
const claimOwner = (dataDir: string) =>
	Effect.gen(function* () {
		const located = yield* locatePidFile(dataDir)
		if (Option.isNone(located)) return undefined
		const owner = yield* pidOwner(located.value.snapshot)
		return owner.kind === "live" ? owner.pid : undefined
	})

/** Opens the store in a scope forked from `parent`, closed again if the start fails. */
const own = (options: LocalOptions, portChoice: PortChoice, parent: Scope.Scope) =>
	Effect.gen(function* () {
		const attempt = yield* Scope.fork(parent)
		return yield* acquireLocal(options, portChoice).pipe(
			Scope.provide(attempt),
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attempt, exit) : Effect.void)),
		)
	})

/**
 * The owner's discovery record, or `None` once nobody holds the claim. It is
 * written right after the owner binds, so a claim moments old may lack one.
 */
const awaitOwnerServer = (dataDir: string, busy: LocalStoreBusyError) =>
	Effect.gen(function* () {
		const pid = yield* claimOwner(dataDir)
		if (pid === undefined) return Option.none<ServerDiscovery>()
		const discovery = yield* readDiscovery(serverDiscoveryPath(dataDir))
		if (Option.isNone(discovery) || discovery.value.pid !== pid) return yield* busy
		return discovery
	}).pipe(Effect.retry({ schedule: Schedule.spaced(Duration.millis(250)), times: 40 }))

const ownOrShare = (
	options: LocalOptions,
	portChoice: PortChoice,
	parent: Scope.Scope,
): Effect.Effect<LocalServer, Effect.Error<ReturnType<typeof acquireLocal>> | LocalUiUrlError> =>
	own(options, portChoice, parent).pipe(
		Effect.catchTag("@maple/local-server/LocalStoreBusyError", (busy) =>
			share(options, portChoice, parent, busy),
		),
	)

/**
 * Serve from the process that already owns this store (the same stack in a
 * second `alchemy dev`) rather than fail, and take the store over on the
 * owner's port once that process lets go of it, so the Workers' endpoint holds.
 */
const share = (
	options: LocalOptions,
	portChoice: PortChoice,
	parent: Scope.Scope,
	busy: LocalStoreBusyError,
) =>
	Effect.gen(function* () {
		const dataDir = resolve(options.dataDir)
		const found = yield* awaitOwnerServer(dataDir, busy)
		// The owner let go while we looked (its own start failed): try to own it again.
		if (Option.isNone(found)) return yield* ownOrShare(options, portChoice, parent)
		const owner = found.value
		const ui = yield* remoteUiUrl
		const port = Number(new URL(owner.url).port)
		yield* Effect.logInfo(
			`Maple Local for ${dataDir} is already running in PID ${owner.pid} (another alchemy dev of this stack); sharing it`,
		)
		yield* Effect.gen(function* () {
			yield* claimOwner(dataDir).pipe(
				Effect.repeat({
					while: (pid) => pid !== undefined,
					schedule: Schedule.spaced(Duration.seconds(1)),
				}),
			)
			yield* Effect.logInfo(`PID ${owner.pid} let go of Maple Local at ${dataDir}; taking it over`)
			yield* ownOrShare(options, { port, strict: false }, parent)
		}).pipe(
			// Never give up while this session runs: a lost race with another sharer, a
			// slow new owner or a store fixed by `maple restore` all resolve on a later try.
			Effect.tapError((error) =>
				Effect.logError(`cannot take over Maple Local at ${dataDir}: ${error.message}; retrying`),
			),
			Effect.retry(
				Schedule.min([Schedule.exponential(Duration.seconds(1)), Schedule.spaced(Duration.seconds(30))]),
			),
			Effect.forkIn(parent),
		)
		return {
			port,
			endpoint: owner.url,
			dashboardUrl: hostedDashboardUrl(ui.url, port),
			dataDir,
			sharedWith: owner.pid,
		} satisfies LocalServer
	})

/**
 * Own one embedded loopback Maple server until the caller's scope closes. No CLI
 * command or Maple executable runs. Unsafe stores fail closed; recovery stays
 * explicit. Periodic checkpoints belong to `maple start`.
 *
 * When another live process already owns the store, it shares that server
 * instead (see {@link share}).
 *
 * A failed start releases everything it acquired (process ownership, the PID
 * claim) before failing, even when the caller keeps its scope open: Alchemy
 * retries a failed local resource in the same process without closing it.
 */
export const startLocal = (options: LocalOptions) =>
	Effect.gen(function* () {
		const portChoice: PortChoice =
			options.port === undefined
				? { port: DEFAULT_PORT, strict: false }
				: { port: options.port, strict: true }
		return yield* ownOrShare(options, portChoice, yield* Scope.Scope)
	})
