import { Duration, Effect, Option, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { randomUUID } from "node:crypto"
import {
	closeSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { ServerBindError, startServer } from "../server/serve"
import { CURRENT_LOCAL_SCHEMA } from "../server/schema-identity"
import {
	adoptLegacySidecars,
	checkStoreCompatible,
	dataDirSidecarPath,
	isSchemaIdentityStale,
	isStoreDirty,
	legacySidecarPath,
	newerStoreSchemaVersion,
	ownsLegacySidecars,
	SERVER_PID_NAME,
	serverDiscoveryPath,
	serverPidPath,
} from "../server/store-version"
import { durableWrite } from "../server/durable-files"
import { abandonLocalStoreMigration, localMigrationIsIncomplete } from "../server/local-store-migrations"
import {
	type CheckpointAvailability,
	checkpointAvailability,
	checkpointRefreshBackoff,
	createCheckpoint,
	formatCheckpointRefreshBackoff,
	parseCheckpointId,
	reconcileCheckpointRecovery,
	resetLiveStorePreservingCheckpoints,
	restoreCheckpoint,
	writeBackupConfig,
} from "../server/checkpoints"
import { resolveUiAssets } from "../server/ui-assets"
import { debugLog } from "../lib/debug"
import { MAPLE_VERSION } from "../version"
import { jsonFormatRequested, writeJson } from "./json-output"
import {
	BackgroundServerExitedError,
	BackgroundServerSpawnError,
	BackgroundServerTimeoutError,
	CheckpointChildError,
	CheckpointUnavailableError,
	LocalStoreDirtyError,
	LocalStoreFromNewerMapleError,
	LocalStoreIncompatibleError,
	LocalStoreMigrationError,
	LocalStoreSchemaStaleError,
	ServerOptionError,
	ServerStateFileError,
	ServerStopTimeoutError,
} from "./server-errors"
import { amber, bold, cyan, dim, green, MARK_LINES, MARK_WIDTH, underline } from "../lib/style"
import {
	buildCheckpointChildArgs,
	buildDetachedChildArgs,
	canonicalUrlHostname,
	type CommandScope,
	commandScope,
	connectionHostForBindHost,
	defaultDataDir,
	type DirtyStorePolicy,
	hostedDashboardUrl,
	hostedUiOrigin,
	ingestedSince,
	isProcessAlive,
	LocalStatus,
	mapleCommand,
	parseElapsedSeconds,
	PID_HANDOVER_ENV,
	prettyPath,
	resolveAdvertiseHost,
	resolveBindHost,
	ServerDiscovery,
	serverProbeUrl,
	serverUrl,
	startedBeforeWrite,
	validateHost,
} from "./server-args"

/**
 * A refused command whose precondition simply wasn't met: the server is already
 * running, isn't running at all, or a destructive command was not confirmed.
 * The message and the non-zero exit are identical to a genuine failure; the
 * separate tag exists so `bin.ts` can close the root span `Ok` for these without
 * also swallowing real start failures (`ServerBindError`,
 * `BackgroundServerTimeoutError`, `LocalStoreDirtyError`). Same rule the ingest
 * gateway follows for expected 4xx.
 */
export class ServerStateError extends Schema.TaggedError<ServerStateError>()("@maple/cli/ServerStateError", {
	message: Schema.String,
}) {}

/** Public origin of the deployed local-mode dashboard SPA. Overridable
 *  (`MAPLE_LOCAL_UI_URL`) for testing against another build of it. */
const DEFAULT_REMOTE_UI_URL = "https://local.maple.dev"

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const errnoCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined

const stateFileError =
	(path: string, action: string) =>
	(error: unknown): ServerStateFileError =>
		new ServerStateFileError({ path, message: `could not ${action} ${path}: ${describeError(error)}` })

const remoteUiUrl = (): Effect.Effect<string, ServerOptionError> => {
	const configured = process.env.MAPLE_LOCAL_UI_URL?.trim() || DEFAULT_REMOTE_UI_URL
	return Effect.try({
		try: () => {
			hostedUiOrigin(configured)
			return configured
		},
		catch: (error) =>
			new ServerOptionError({
				source: "MAPLE_LOCAL_UI_URL",
				message: `invalid MAPLE_LOCAL_UI_URL: ${describeError(error)}`,
			}),
	})
}

const validatedHost = (source: string, value: string): Effect.Effect<string, ServerOptionError> =>
	Effect.try({
		try: () => validateHost(value),
		catch: (error) =>
			new ServerOptionError({ source, message: `invalid ${source}: ${describeError(error)}` }),
	})

/** The startup banner shown once the server is listening. `dashboardUrl` is the
 *  URL the user should open (the auto-updating `local.maple.dev` by default, or
 *  the bundled same-origin UI with `--offline`); `undefined` when no UI. */
const startBanner = (
	bindAddr: string,
	connectAddr: string,
	dataDir: string,
	dashboardUrl: string | undefined,
	offline: boolean,
	scope: CommandScope,
): string => {
	// No leading indent here: the gutter below supplies it.
	const row = (key: string, value: string) => `${dim(key.padEnd(11))}${value}`
	const content = [
		// The lockup. Mono has only one face, so the tension that carries it in
		// the UI (display vs. mono) becomes weight: `maple` bold, `local` dim.
		`${bold("maple")} ${dim("local")}`,
		`${green("●")} listening on ${cyan(underline(bindAddr))}`,
		"",
		...(connectAddr === bindAddr ? [] : [row("connect", cyan(connectAddr))]),
		row("OTLP/HTTP", `POST ${dim("/v1/{traces,logs,metrics}")}`),
		row("env", `export OTEL_EXPORTER_OTLP_ENDPOINT=${connectAddr}`),
		row("query", `POST ${dim("/local/query")}`),
		...(dashboardUrl
			? [
					row("dashboard", cyan(dashboardUrl)),
					...(offline ? [] : [`${" ".repeat(11)}${dim("· bundled UI: pass --offline")}`]),
				]
			: []),
		row("data", prettyPath(dataDir)),
		row("pid", `${process.pid}  ${dim("· stop with")} ${bold(mapleCommand("stop", scope))}`),
	]

	// The mark rides in a left gutter rather than sitting above the rows, so it
	// costs no vertical space: the content is already as tall as the mark. On a
	// terminal too narrow to seat it, the mark is dropped and the wordmark
	// carries local mode alone; a wrapped banner is worse than no glyph.
	//
	// The threshold covers the gutter plus the key column plus a readable value.
	// It deliberately does NOT measure the longest line: a dashboard URL or a
	// `--data-dir` can be arbitrarily long, and those already wrap today. Gating
	// on them would make the glyph blink out for reasons the user can't see.
	const lines =
		(process.stderr.columns ?? 80) >= 72
			? Array.from({ length: Math.max(MARK_LINES.length, content.length) }, (_, i) =>
					`  ${amber(MARK_LINES[i] ?? " ".repeat(MARK_WIDTH))}   ${content[i] ?? ""}`.trimEnd(),
				)
			: content.map((line) => `  ${line}`)

	return `\n${lines.join("\n")}\n\n`
}

// ---------------------------------------------------------------------------
// PID file: the one claim that serializes `start`, `reset` and `restore`.
// ---------------------------------------------------------------------------

interface PidFileSnapshot {
	readonly raw: string
	readonly pid: number | undefined
	readonly ino: number
	readonly mtimeMs: number
}

const readPidSnapshot = (path: string): Effect.Effect<Option.Option<PidFileSnapshot>> =>
	Effect.try({
		try: (): PidFileSnapshot => {
			const raw = readFileSync(path, "utf8")
			const info = statSync(path)
			const pid = Number.parseInt(raw.trim(), 10)
			return {
				raw,
				pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
				ino: info.ino,
				mtimeMs: info.mtimeMs,
			}
		},
		catch: (error) => error,
	}).pipe(Effect.option)

const sameSnapshot = (a: PidFileSnapshot, b: PidFileSnapshot): boolean =>
	a.raw === b.raw && a.ino === b.ino && a.mtimeMs === b.mtimeMs

/** Wall-clock start of a live process (`ps -o etime=`), when it can be known. */
const processStartedAtMs = (pid: number): Effect.Effect<Option.Option<number>> =>
	Effect.try({
		try: () =>
			Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }),
		catch: (error) => error,
	}).pipe(
		Effect.map((result) => {
			const seconds = result.success ? parseElapsedSeconds(result.stdout.toString()) : undefined
			return seconds === undefined ? Option.none<number>() : Option.some(Date.now() - seconds * 1000)
		}),
		Effect.orElseSucceed(() => Option.none<number>()),
	)

type PidOwner =
	| { readonly kind: "stale" }
	/** `verified`: the process provably started before the file was written. */
	| { readonly kind: "live"; readonly pid: number; readonly verified: boolean }

const STALE_PID: PidOwner = { kind: "stale" }
const livePid = (pid: number, verified: boolean): PidOwner => ({ kind: "live", pid, verified })

/**
 * Does the process named by a PID file still own it? After a crash or reboot
 * the number may belong to an unrelated process, which necessarily started
 * after the file was written. Without `ps` the answer is "live, unverified",
 * the conservative reading for every caller.
 */
const pidOwner = (snapshot: PidFileSnapshot): Effect.Effect<PidOwner> =>
	Effect.gen(function* () {
		const pid = snapshot.pid
		if (pid === undefined || !isProcessAlive(pid)) return STALE_PID
		const startedAt = yield* processStartedAtMs(pid)
		if (Option.isNone(startedAt)) return livePid(pid, false)
		return startedBeforeWrite(startedAt.value, snapshot.mtimeMs) ? livePid(pid, true) : STALE_PID
	})

/** O_EXCL create; `false` when the file already exists. */
const createExclusive = (path: string, content: string): Effect.Effect<boolean, ServerStateFileError> =>
	Effect.try({
		try: () => {
			writeFileSync(path, content, { mode: 0o600, flag: "wx" })
			return true
		},
		catch: (error) => error,
	}).pipe(
		Effect.catch((error) =>
			errnoCode(error) === "EEXIST"
				? Effect.succeed(false)
				: Effect.fail(stateFileError(path, "create")(error)),
		),
	)

/** Atomically replace the file's content (write aside, rename over). */
const replaceFile = (path: string, content: string): Effect.Effect<void, ServerStateFileError> =>
	Effect.try({
		try: () => {
			const temporary = `${path}.${randomUUID()}.tmp`
			writeFileSync(temporary, content, { mode: 0o600, flag: "wx" })
			renameSync(temporary, path)
		},
		catch: stateFileError(path, "replace"),
	})

const ignoreFailure = (thunk: () => void): Effect.Effect<void> =>
	Effect.try({ try: thunk, catch: (error) => error }).pipe(Effect.ignore)

/**
 * Remove a stale PID file without ever deleting a claim that a concurrent
 * start published after we read it: move it aside, and only discard it if it
 * is byte-for-byte the file we judged stale; otherwise put it back and yield.
 */
const takeOverStalePidFile = (
	path: string,
	observed: PidFileSnapshot,
	busy: (pid: number | undefined) => ServerStateError,
): Effect.Effect<void, ServerStateError | ServerStateFileError> =>
	Effect.gen(function* () {
		const moved = `${path}.stale-${randomUUID()}`
		const renamed = yield* Effect.try({
			try: () => {
				renameSync(path, moved)
				return true
			},
			catch: (error) => error,
		}).pipe(
			Effect.catch((error) =>
				errnoCode(error) === "ENOENT"
					? Effect.succeed(false)
					: Effect.fail(stateFileError(path, "replace the stale PID file")(error)),
			),
		)
		if (!renamed) return
		const current = yield* readPidSnapshot(moved)
		if (Option.isSome(current) && sameSnapshot(current.value, observed)) {
			yield* ignoreFailure(() => unlinkSync(moved))
			return
		}
		yield* ignoreFailure(() => linkSync(moved, path))
		yield* ignoreFailure(() => unlinkSync(moved))
		return yield* busy(Option.isSome(current) ? current.value.pid : undefined)
	})

const alreadyRunning =
	(scope: CommandScope) =>
	(pid: number | undefined): ServerStateError =>
		new ServerStateError({
			message:
				`maple is already running or starting${pid === undefined ? "" : ` (PID ${pid})`}; ` +
				`stop it with \`${mapleCommand("stop", scope)}\``,
		})

const runningRefusal =
	(scope: CommandScope) =>
	(pid: number | undefined): ServerStateError =>
		new ServerStateError({
			message:
				`maple is running${pid === undefined ? "" : ` (PID ${pid})`}; ` +
				`stop it first with \`${mapleCommand("stop", scope)}\``,
		})

/**
 * Exclusively claim the PID file so exactly one `start`, `reset` or `restore`
 * touches the store. A stale file (dead or reused PID) is taken over safely.
 * `handoverFrom` lets a `start -d` child inherit its parent's claim.
 */
export const claimPidFileExclusive = (
	pidPath: string,
	options: {
		readonly handoverFrom?: number | undefined
		readonly busy?: (pid: number | undefined) => ServerStateError
	} = {},
): Effect.Effect<void, ServerStateError | ServerStateFileError> =>
	Effect.gen(function* () {
		const busy = options.busy ?? alreadyRunning({})
		yield* Effect.try({
			try: () => mkdirSync(dirname(pidPath), { recursive: true }),
			catch: stateFileError(dirname(pidPath), "create"),
		})
		const content = String(process.pid)
		for (let attempt = 0; attempt < 4; attempt++) {
			if (yield* createExclusive(pidPath, content)) return
			const observed = yield* readPidSnapshot(pidPath)
			if (Option.isNone(observed)) continue
			const owner = yield* pidOwner(observed.value)
			if (owner.kind === "live") {
				if (owner.pid === options.handoverFrom) return yield* replaceFile(pidPath, content)
				return yield* busy(owner.pid)
			}
			yield* takeOverStalePidFile(pidPath, observed.value, busy)
		}
		return yield* busy(undefined)
	})

/** Remove the PID file only while it still names this process. */
const releasePidFile = (pidPath: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const current = yield* readPidSnapshot(pidPath)
		if (Option.isSome(current) && current.value.pid === process.pid) {
			yield* ignoreFailure(() => unlinkSync(pidPath))
		}
	})

/** The PID file of the server that owns `dataDir`: the current-layout one, or
 *  the one an older maple wrote for a custom `--data-dir` before upgrading. */
const locatePidFile = (
	dataDir: string,
): Effect.Effect<Option.Option<{ path: string; snapshot: PidFileSnapshot }>> =>
	Effect.gen(function* () {
		const candidates = [
			serverPidPath(dataDir),
			...(ownsLegacySidecars(dataDir) ? [legacySidecarPath(dataDir, SERVER_PID_NAME)] : []),
		]
		for (const path of candidates) {
			const snapshot = yield* readPidSnapshot(path)
			if (Option.isSome(snapshot)) return Option.some({ path, snapshot: snapshot.value })
		}
		return Option.none()
	})

/** Refuse when a live server owns `dataDir`, including one an older maple
 *  started from the legacy PID file. */
const refuseIfRunning = (
	dataDir: string,
	refusal: (pid: number | undefined) => ServerStateError,
): Effect.Effect<void, ServerStateError> =>
	Effect.gen(function* () {
		const located = yield* locatePidFile(dataDir)
		if (Option.isNone(located)) return
		const owner = yield* pidOwner(located.value.snapshot)
		if (owner.kind === "live") return yield* refusal(owner.pid)
	})

/** Explicit adoption of pre-namespacing state files, surfaced when it fails. */
const adoptSidecars = (dataDir: string): Effect.Effect<void, ServerStateFileError> =>
	Effect.try({
		try: () => {
			const adopted = adoptLegacySidecars(dataDir)
			if (adopted.length > 0) debugLog("adopted legacy store files", adopted.join(", "))
		},
		catch: stateFileError(dataDir, "adopt the legacy state files beside"),
	})

// ---------------------------------------------------------------------------
// Discovery file and status probe.
// ---------------------------------------------------------------------------

const decodeDiscovery = Schema.decodeUnknownOption(Schema.fromJsonString(ServerDiscovery))

const readDiscovery = (dataDir: string): Effect.Effect<Option.Option<ServerDiscovery>> =>
	Effect.try({
		try: () => readFileSync(serverDiscoveryPath(dataDir), "utf8"),
		catch: (error) => error,
	}).pipe(
		Effect.map(decodeDiscovery),
		Effect.orElseSucceed(() => Option.none<ServerDiscovery>()),
	)

/** Delete the discovery file when (and only when) it names `pid`. */
const removeDiscoveryFor = (dataDir: string, pid: number): Effect.Effect<void> =>
	Effect.gen(function* () {
		const current = yield* readDiscovery(dataDir)
		if (Option.isSome(current) && current.value.pid === pid) {
			yield* ignoreFailure(() => unlinkSync(serverDiscoveryPath(dataDir)))
		}
	})

/** Delete a discovery file whose server is gone (crash, `kill -9`). */
const removeStaleDiscovery = (dataDir: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const current = yield* readDiscovery(dataDir)
		if (
			Option.isSome(current) &&
			current.value.pid !== process.pid &&
			!isProcessAlive(current.value.pid)
		) {
			yield* ignoreFailure(() => unlinkSync(serverDiscoveryPath(dataDir)))
		}
	})

/**
 * `GET /local/status`, untraced: readiness polls hit ECONNREFUSED until the
 * child binds, and each would otherwise close an `http.client` span as `Error`
 * inside an `Ok` root span. `TracerDisabledWhen` is scoped to this request so
 * real calls stay traced.
 */
const fetchLocalStatus = (
	baseUrl: string,
	timeout: Duration.Input = "500 millis",
): Effect.Effect<Option.Option<LocalStatus>, never, HttpClient.HttpClient> =>
	HttpClient.get(`${baseUrl}/local/status`).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.flatMap(HttpClientResponse.schemaBodyJson(LocalStatus)),
		Effect.timeout(timeout),
		Effect.option,
		Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
	)

// ---------------------------------------------------------------------------
// Flags.
// ---------------------------------------------------------------------------

const port = Flag.Int("port").pipe(
	Flag.withDescription("Port for OTLP/HTTP ingest, the query API, and the bundled UI"),
	Flag.withDefault(4318),
)

const host = Flag.String("host").pipe(
	Flag.withDescription(
		"Local server host (env: MAPLE_LOCAL_BIND_HOST; non-loopback start exposes unauthenticated ingest and queries)",
	),
	Flag.withDefault(resolveBindHost(process.env.MAPLE_LOCAL_BIND_HOST)),
)

const checkpointPort = Flag.Int("port").pipe(
	Flag.withDescription("Port of the running `maple start` server to checkpoint"),
	Flag.withDefault(4318),
)

const checkpointHost = Flag.String("host").pipe(
	Flag.withDescription(
		"Host of the running `maple start` server to checkpoint (env: MAPLE_LOCAL_BIND_HOST)",
	),
	Flag.withDefault(resolveBindHost(process.env.MAPLE_LOCAL_BIND_HOST)),
)

const advertiseHostFlag = Flag.optional(
	Flag.String("advertise-host").pipe(
		Flag.withDescription(
			"Hostname or address printed for clients and the bundled UI (env: MAPLE_LOCAL_ADVERTISE_HOST)",
		),
	),
)

const dataDirFlag = Flag.optional(
	Flag.String("data-dir").pipe(
		Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)"),
	),
)

const chdbConfigFileFlag = Flag.optional(
	Flag.String("chdb-config-file").pipe(
		Flag.withDescription(
			"ClickHouse config file for embedded chDB (default: a generated backups-enabled config beside the data dir)",
		),
	),
)

const minimumRawTelemetryRetentionDaysFlag = Flag.optional(
	Flag.Int("minimum-raw-telemetry-retention-days").pipe(
		Flag.withDescription(
			"Persist a monotonic raw-table retention floor (minimum 90 days; survives reset and restore)",
		),
	),
)

const backgroundFlag = Flag.Boolean("background").pipe(
	Flag.withAlias("d"),
	Flag.withDescription(
		"Run the server detached (logs to maple.log beside the data dir, e.g. ~/.maple/maple.log); stop with `maple stop`",
	),
	Flag.withDefault(false),
)

const resetFlag = Flag.Boolean("reset").pipe(
	Flag.withDescription(
		"Wipe live chDB data before starting while preserving checkpoints; use after an incompatible upgrade",
	),
	Flag.withDefault(false),
)

/** Default refresh cadence. A crash costs at most this much telemetry. */
const CHECKPOINT_INTERVAL_DEFAULT = "30m"

const checkpointIntervalFlag = Flag.String("checkpoint-interval").pipe(
	Flag.withDescription(
		"How often to refresh the store's restore point while running (e.g. 45s, 30m, 2h; `off` to disable)",
	),
	Flag.withDefault(CHECKPOINT_INTERVAL_DEFAULT),
)

const onDirtyStoreFlag = Flag.Literals("on-dirty-store", ["wipe", "fail", "restore-checkpoint"]).pipe(
	Flag.withDescription("Recovery policy when the local chDB store was not cleanly closed"),
	Flag.withDefault("fail" as const),
)

const yesFlag = Flag.Boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDescription("Skip the confirmation prompt"),
	Flag.withDefault(false),
)

const checkpointIdFlag = Flag.optional(
	Flag.String("checkpoint-id").pipe(
		Flag.withDescription("Restore one immutable checkpoint ID instead of the selected current"),
	),
)

const offlineFlag = Flag.Boolean("offline").pipe(
	Flag.withDescription(
		"Use the UI bundled in this binary (served from the configured bind host) instead of local.maple.dev",
	),
	Flag.withDefault(false),
)

// Log file for `--background` runs, beside the PID file (e.g. ~/.maple/maple.log).
const logFilePath = (dataDir: string): string => dataDirSidecarPath(dataDir, "maple.log")

/** `maple.log` is rotated to `maple.log.1` at a background start once it passes this. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024

// Generated chDB config, beside the PID and log files (e.g. ~/.maple/chdb-config.xml).
export const chdbConfigPath = (dataDir: string): string => dataDirSidecarPath(dataDir, "chdb-config.xml")

/**
 * Resolve the chDB config file, generating a backups-enabled default when the
 * user did not supply one.
 *
 * `BACKUP DATABASE default TO Disk('default', …)` (how every checkpoint is
 * taken) needs `<backups><allowed_disk>` in the config of the *running* chDB
 * connection. chDB allows one connection per process, acquired once at start and
 * held for the process lifetime, and `maple checkpoint` is a separate process
 * talking over HTTP: it cannot inject config into a live connection. So a server
 * started without a backups config can never checkpoint. A user-supplied
 * `--chdb-config-file` is honoured untouched.
 */
export const resolveChdbConfigFile = (dataDir: string, supplied: string | undefined) =>
	Effect.gen(function* () {
		if (supplied !== undefined) return supplied
		const fs = yield* FileSystem
		const path = chdbConfigPath(dataDir)
		// Regenerated every start: idempotent, and it self-heals a truncated or
		// hand-edited file. Failing to write is not fatal: the server still starts,
		// checkpoints just stay unavailable, which is the old behaviour.
		yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(Effect.ignore)
		return yield* Effect.try({
			try: () => {
				writeBackupConfig(path)
				return path
			},
			catch: (error) => error,
		}).pipe(Effect.orElseSucceed(() => undefined))
	})

/**
 * What to tell someone whose local store was left dirty, given whether a
 * checkpoint is actually restorable. Every branch names at least one command
 * that will work from the state they are in, for the store they named.
 */
export const dirtyStoreRecoveryAdvice = (
	availability: CheckpointAvailability,
	scope: CommandScope = {},
): string => {
	const resetCommand = bold(mapleCommand("start --reset", scope))
	if (availability.available) {
		return (
			`Run \`${bold(mapleCommand("restore --yes", scope))}\` to restore from the last checkpoint ` +
			`(${dim(availability.checkpointId)}), or \`${resetCommand}\` to wipe it.`
		)
	}
	const why =
		availability.reason === "none"
			? "No checkpoint has ever been taken for this store, so there is nothing to restore from"
			: `The checkpoint registry is unusable (${availability.detail}), so restoring from it is not safe`
	return (
		`${why}; the unreadable live data cannot be recovered. ` +
		`Start fresh with \`${resetCommand}\`; ` +
		`once running, \`${bold(mapleCommand("checkpoint", scope))}\` creates a restore point for next time.`
	)
}

/** How long `maple start --background` waits for the detached child to report
 *  ready, and how often it checks. Opening a large store (physical-schema
 *  verification, retired-day replay) can take well over the old 10s. */
const BACKGROUND_READY_POLL_MS = 200
const BACKGROUND_READY_TIMEOUT_MS = 120_000
/** After this long, say why we are still waiting rather than looking hung. */
const BACKGROUND_SLOW_NOTICE_MS = 5_000
/** How long a timed-out child gets to shut down cleanly after SIGTERM. */
const BACKGROUND_ABORT_GRACE_MS = 20_000

/**
 * Parse `--checkpoint-interval`. `off`/`0` disables refreshing and returns
 * `undefined`; anything unparseable is rejected rather than silently defaulted,
 * because a typo that quietly turned checkpointing off would reintroduce exactly
 * the data loss this exists to prevent.
 */
export const parseCheckpointInterval = (value: string): Duration.Duration | undefined | "invalid" => {
	const raw = value.trim().toLowerCase()
	if (raw === "off" || raw === "0" || raw === "none") return undefined
	const match = raw.match(/^(\d+)\s*(s|m|h)$/)
	if (!match) return "invalid"
	const amount = Number(match[1])
	if (amount <= 0) return undefined
	return match[2] === "s"
		? Duration.seconds(amount)
		: match[2] === "m"
			? Duration.minutes(amount)
			: Duration.hours(amount)
}

/**
 * Should `maple start` take an opening checkpoint? Only ever the first one, and
 * only for a store that actually holds something.
 *
 * A store that already has a checkpoint, or one whose registry is present but
 * *unusable*, is one the user is already managing. Taking another on every
 * start would be a background BACKUP nobody asked for, and overwriting an
 * unusable registry would destroy the evidence of why it broke.
 *
 * `hasLiveData` is what keeps this honest. Backing up an empty store produces a
 * checkpoint that restores to nothing; the case worth protecting is the store
 * that already has telemetry and has never been checkpointed, which is every
 * existing install on the first start after upgrading.
 */
export const needsInitialCheckpoint = (availability: CheckpointAvailability, hasLiveData: boolean): boolean =>
	hasLiveData && !availability.available && availability.reason === "none"

/**
 * Does the store hold live data, as opposed to just the preserved checkpoint
 * registry? `backups` is skipped for the same reason it is skipped when the
 * live store is reset: it is not part of the data being protected.
 */
const storeHasLiveData = (dataDir: string): Effect.Effect<boolean, never, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		return yield* fs.readDirectory(dataDir).pipe(
			Effect.map((entries) => entries.some((entry) => entry !== "backups")),
			Effect.orElseSucceed(() => false),
		)
	})

/**
 * Take the store's FIRST checkpoint, once the server is up, if it has none.
 * Runs after the banner, so it delays nothing the user is waiting on, and is
 * non-fatal: a store that cannot be checkpointed still serves telemetry.
 * Returns when the checkpoint was started, if one was taken.
 */
const ensureInitialCheckpoint = (
	target: CheckpointTarget,
	hadLiveData: boolean,
): Effect.Effect<Option.Option<number>> =>
	Effect.gen(function* () {
		const availability = yield* Effect.promise(() => checkpointAvailability(target.dataDir))
		if (!needsInitialCheckpoint(availability, hadLiveData)) return Option.none<number>()

		yield* Effect.sync(() =>
			process.stderr.write(dim("◌ taking the store's first checkpoint (restore point)…\n")),
		)
		const startedAt = Date.now()
		return (yield* takeCheckpointQuietly(target, "initial"))
			? Option.some(startedAt)
			: Option.none<number>()
	})

interface CheckpointTarget {
	readonly dataDir: string
	readonly host: string
	readonly port: number
	readonly scope: CommandScope
}

/**
 * Take a checkpoint without ever letting it end the server.
 *
 * Spawned as a CHILD `maple checkpoint`, the same thing a user runs by hand:
 * the child posts `BACKUP` to this server and then validates the result in
 * its own chDB process, which the server's single connection cannot host.
 *
 * The child is a scoped resource: if shutdown interrupts us mid-checkpoint, the
 * release asks it to stop and WAITS for it, so it never outlives the server
 * holding the maintenance lock (the next `start`/`restore` would be refused).
 * The child finishes its locked section before exiting, and the listener is
 * still up while we wait because this fiber is released before the server.
 *
 * Quiet on stderr but never silent: the child's own output carries the cause
 * under `--debug`. `root: true` keeps each checkpoint its own trace instead of
 * hanging off the long-lived `maple` span the loop was forked under.
 */
const takeCheckpointQuietly = (
	target: CheckpointTarget,
	reason: "initial" | "refresh",
): Effect.Effect<boolean> =>
	Effect.acquireUseRelease(
		Effect.try({
			try: () =>
				Bun.spawn(
					[
						process.execPath,
						...buildCheckpointChildArgs({
							entry: process.argv[1],
							host: target.host,
							port: target.port,
							dataDir: target.dataDir,
						}),
					],
					{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
				),
			catch: (error): CheckpointChildError =>
				new CheckpointChildError({
					reason,
					exitCode: -1,
					message: `could not spawn maple checkpoint: ${describeError(error)}`,
				}),
		}),
		(child) =>
			Effect.promise(() => Promise.all([child.exited, new Response(child.stderr).text()])).pipe(
				Effect.flatMap(([exitCode, stderr]) =>
					exitCode === 0
						? Effect.void
						: Effect.fail(
								new CheckpointChildError({
									reason,
									exitCode,
									message: stderr.trim() || `maple checkpoint exited ${exitCode}`,
								}),
							),
				),
			),
		(child) =>
			child.exitCode === null && child.signalCode === null
				? Effect.promise(async () => {
						child.kill("SIGTERM")
						await child.exited
					})
				: Effect.void,
	).pipe(
		Effect.matchEffect({
			onSuccess: () =>
				Effect.sync(() => {
					process.stderr.write(
						reason === "initial"
							? `${green("✓")} checkpoint taken; recover an unclean shutdown with ` +
									`${bold(mapleCommand("restore --yes", target.scope))}\n`
							: dim("◌ checkpoint refreshed\n"),
					)
					return true
				}),
			onFailure: (error) =>
				Effect.sync(() => {
					debugLog(`checkpoint (${reason}) failed`, error.message)
					process.stderr.write(
						reason === "initial"
							? dim(
									`◌ could not take an initial checkpoint; run ${bold(mapleCommand("checkpoint", target.scope))} to retry\n`,
								)
							: dim("◌ could not refresh the checkpoint; the previous one still stands\n"),
					)
					return false
				}),
		}),
		Effect.withSpan("cli.checkpoint", {
			root: true,
			attributes: { "maple.checkpoint.reason": reason },
		}),
	)

/**
 * Refresh the store's restore point on an interval for as long as the server
 * runs, so a crash costs at most one interval of telemetry.
 *
 * `BACKUP` runs on the server's own JS thread and stalls ingest and queries
 * while it runs, so an idle server skips it: once this process has a
 * checkpoint, a tick with nothing ingested since that checkpoint started
 * (`/local/status` `lastIngestAtMs`) has nothing new to protect. Consecutive
 * failures back the interval off (`checkpointRefreshBackoff`).
 */
const checkpointRefreshLoop = (
	target: CheckpointTarget,
	interval: Duration.Duration,
	initialTakenAtMs: Option.Option<number>,
): Effect.Effect<never, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		let lastTakenAtMs = Option.getOrUndefined(initialTakenAtMs)
		const statusUrl = serverUrl(target.host, target.port)
		while (true) {
			const backoff = yield* checkpointRefreshBackoff(target.dataDir, interval)
			const note = formatCheckpointRefreshBackoff(
				backoff,
				mapleCommand(
					"checkpoint",
					commandScope({ dataDir: target.dataDir, port: target.port, host: target.host }),
				),
			)
			if (note !== null) yield* Effect.sync(() => process.stderr.write(dim(`◌ ${note}\n`)))
			yield* Effect.sleep(backoff.delay)
			if (lastTakenAtMs !== undefined) {
				const status = yield* fetchLocalStatus(statusUrl, "5 seconds")
				const lastIngestAtMs = Option.isSome(status) ? status.value.lastIngestAtMs : undefined
				if (!ingestedSince(lastIngestAtMs, lastTakenAtMs)) {
					debugLog("checkpoint refresh skipped", "nothing ingested since the last checkpoint")
					continue
				}
			}
			const startedAt = Date.now()
			if (yield* takeCheckpointQuietly(target, "refresh")) lastTakenAtMs = startedAt
		}
	})

/** Fail fast when the port is taken. Not atomic (the real bind can still lose
 *  a race), but it keeps a busy port from costing a reset or a wipe. */
const ensurePortFree = (hostname: string, port: number): Effect.Effect<void, ServerBindError> =>
	Effect.try({
		try: () => Bun.listen({ hostname, port, socket: { data() {} } }).stop(true),
		catch: (error) =>
			new ServerBindError({
				hostname,
				port,
				message:
					errnoCode(error) === "EADDRINUSE"
						? `port ${port} on ${hostname} is already in use; choose another with --port, or stop whatever holds it`
						: `cannot bind ${hostname}:${port}: ${describeError(error)}`,
			}),
	})

const fileSize = (path: string): number =>
	Effect.runSync(
		Effect.try({ try: () => statSync(path).size, catch: (error) => error }).pipe(
			Effect.orElseSucceed(() => 0),
		),
	)

/** Keep `maple.log` bounded: every background start appends to it. */
const rotateLogIfLarge = (logPath: string): Effect.Effect<void> =>
	fileSize(logPath) > LOG_ROTATE_BYTES
		? ignoreFailure(() => renameSync(logPath, `${logPath}.1`))
		: Effect.void

/** The child's own failure from what this run appended to the log: its last
 *  `error:` line, else its last line. Error output shows one line only. */
const childFailureLine = (logPath: string, fromByte: number): string =>
	Effect.runSync(
		Effect.try({
			try: () => {
				const lines = readFileSync(logPath)
					.subarray(fromByte)
					.toString("utf8")
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
				return [...lines].reverse().find((line) => line.startsWith("error:")) ?? lines.at(-1) ?? ""
			},
			catch: (error) => error,
		}).pipe(Effect.orElseSucceed(() => "")),
	)

interface DetachedStart {
	readonly bindHost: string
	readonly advertiseHost: string
	readonly port: number
	readonly dataDir: string
	readonly offline: boolean
	readonly hostedUiUrl: string | undefined
	readonly chdbConfigFile: string | undefined
	readonly onDirtyStore: DirtyStorePolicy
	readonly minimumRawTelemetryRetentionDays: number | undefined
	readonly checkpointInterval: string
	readonly scope: CommandScope
}

type ChildReadiness = { readonly kind: "ready" } | { readonly kind: "exited" } | { readonly kind: "timeout" }

/**
 * Re-exec `maple start` detached, dropping `--background`/`-d` so the child runs
 * the normal foreground path. Called with this process holding the PID claim
 * and every destructive step already done; the child inherits the claim via
 * `PID_HANDOVER_ENV`, so the store is never unclaimed in between. Ready means
 * `/local/status` answers with the CHILD's pid: a `/health` 200 could come from
 * another server already on the port.
 */
const startDetached = (options: DetachedStart) =>
	Effect.gen(function* () {
		const logPath = logFilePath(options.dataDir)
		yield* rotateLogIfLarge(logPath)
		const logOffset = fileSize(logPath)
		// Rebuild the command explicitly rather than slicing argv: a Bun-compiled
		// binary injects a virtual `/$bunfs/...` entrypoint at argv[1] that must
		// not be forwarded. In dev (`bun run src/bin.ts`) argv[1] is the real
		// script and Bun needs it; in the compiled binary execPath alone suffices.
		const childArgs = buildDetachedChildArgs({
			entry: process.argv[1],
			host: options.bindHost,
			advertiseHost: options.advertiseHost,
			port: options.port,
			dataDir: options.dataDir,
			offline: options.offline,
			chdbConfigFile: options.chdbConfigFile,
			onDirtyStore: options.onDirtyStore,
			minimumRawTelemetryRetentionDays: options.minimumRawTelemetryRetentionDays,
			checkpointInterval: options.checkpointInterval,
		})

		const spawnError = (error: unknown) =>
			new BackgroundServerSpawnError({
				logPath,
				message: `failed to spawn background server: ${describeError(error)}`,
			})
		// The child gets its own copy of the log descriptor; ours is closed right after.
		const child = yield* Effect.acquireUseRelease(
			Effect.try({ try: () => openSync(logPath, "a", 0o600), catch: spawnError }),
			(fd) =>
				Effect.try({
					try: () => {
						const proc = Bun.spawn([process.execPath, ...childArgs], {
							stdin: "ignore",
							stdout: fd,
							stderr: fd,
							env: { ...process.env, [PID_HANDOVER_ENV]: String(process.pid) },
						})
						proc.unref()
						return proc
					},
					catch: spawnError,
				}),
			(fd) => ignoreFailure(() => closeSync(fd)),
		)
		const childRunning = () => child.exitCode === null && child.signalCode === null

		const bindAddr = serverUrl(options.bindHost, options.port)
		const connectAddr = serverUrl(options.advertiseHost, options.port)
		const probeAddr = serverProbeUrl(options.bindHost, options.port)
		// One span for the whole readiness wait, never one per probe.
		const readiness = yield* Effect.gen(function* () {
			const startedAt = Date.now()
			let noticed = false
			for (let attempt = 1; Date.now() - startedAt < BACKGROUND_READY_TIMEOUT_MS; attempt++) {
				yield* Effect.sleep(`${BACKGROUND_READY_POLL_MS} millis`)
				if (!childRunning()) {
					yield* Effect.annotateCurrentSpan({
						"maple.server.probe_attempt": attempt,
						"maple.server.exited_early": true,
					})
					return { kind: "exited" } satisfies ChildReadiness
				}
				const status = yield* fetchLocalStatus(probeAddr)
				// Fallback for a server without `/local/status`: the discovery file
				// is only written once the child is listening.
				const discovery: Option.Option<ServerDiscovery> = Option.isSome(status)
					? Option.none()
					: yield* readDiscovery(options.dataDir)
				if (
					(Option.isSome(status) && status.value.pid === child.pid) ||
					(Option.isSome(discovery) && discovery.value.pid === child.pid)
				) {
					yield* Effect.annotateCurrentSpan({ "maple.server.probe_attempt": attempt })
					return { kind: "ready" } satisfies ChildReadiness
				}
				if (!noticed && Date.now() - startedAt > BACKGROUND_SLOW_NOTICE_MS) {
					noticed = true
					yield* Effect.sync(() =>
						process.stderr.write(dim("◌ still opening the store (large stores take longer)…\n")),
					)
				}
			}
			return { kind: "timeout" } satisfies ChildReadiness
		}).pipe(Effect.withSpan("server.wait_ready", { attributes: { "server.address": probeAddr } }))

		if (readiness.kind === "exited") {
			const cause = childFailureLine(logPath, logOffset)
			return yield* new BackgroundServerExitedError({
				logPath,
				exitCode: child.exitCode,
				message:
					`background server exited during startup` +
					(cause ? ` (${cause.replace(/^error:\s*/, "")})` : "") +
					`; full log: ${prettyPath(logPath)}`,
			})
		}
		if (readiness.kind === "timeout") {
			// Never leave a half-started child behind: the next start would only
			// report it as "already running".
			yield* Effect.sync(() => child.kill("SIGTERM"))
			const stopped = yield* Effect.promise(() => child.exited).pipe(
				Effect.timeout(`${BACKGROUND_ABORT_GRACE_MS} millis`),
				Effect.option,
			)
			return yield* new BackgroundServerTimeoutError({
				logPath,
				timeoutMs: BACKGROUND_READY_TIMEOUT_MS,
				message:
					`background server did not become ready within ${BACKGROUND_READY_TIMEOUT_MS / 1000}s ` +
					(Option.isSome(stopped)
						? "and was stopped"
						: `and is still shutting down (PID ${child.pid}); stop it with \`${mapleCommand("stop", options.scope)}\``) +
					`. Check ${prettyPath(logPath)}`,
			})
		}

		const assets = options.offline ? yield* resolveUiAssets() : undefined
		const dashboardUrl = options.offline
			? assets !== undefined
				? `${connectAddr}/`
				: undefined
			: options.hostedUiUrl === undefined
				? undefined
				: hostedDashboardUrl(options.hostedUiUrl, options.port)
		yield* Effect.sync(() =>
			process.stderr.write(
				`${green("✓")} maple started in background ${dim(`(PID ${child.pid})`)}\n` +
					`  ${dim("listening")} ${cyan(underline(bindAddr))}\n` +
					(connectAddr === bindAddr ? "" : `  ${dim("connect")}   ${cyan(connectAddr)}\n`) +
					(dashboardUrl === undefined ? "" : `  ${dim("dashboard")} ${cyan(dashboardUrl)}\n`) +
					`  ${dim("env")}       export OTEL_EXPORTER_OTLP_ENDPOINT=${connectAddr}\n` +
					`  ${dim("logs")}      ${prettyPath(logPath)}\n` +
					`  ${dim("stop")}      ${bold(mapleCommand("stop", options.scope))}\n`,
			),
		)
	})

/** After a reset or wipe: the pre-reset checkpoints stay, pinned against rotation. */
const reportPreserved = (count: number, scope: CommandScope): Effect.Effect<void> =>
	count === 0
		? Effect.void
		: Effect.sync(() =>
				process.stderr.write(
					dim(
						`  kept ${count} checkpoint${count === 1 ? "" : "s"} (pinned; release with ` +
							`\`${mapleCommand("schema gc --apply --release-preserved", scope)}\`)\n`,
					),
				),
			)

/** A `start -d` parent's PID, when this process is its detached child. */
const pidHandoverFrom = (): number | undefined => {
	const pid = Number.parseInt(process.env[PID_HANDOVER_ENV] ?? "", 10)
	return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export const start = Command.make("start", {
	host,
	advertiseHost: advertiseHostFlag,
	port,
	dataDir: dataDirFlag,
	chdbConfigFile: chdbConfigFileFlag,
	minimumRawTelemetryRetentionDays: minimumRawTelemetryRetentionDaysFlag,
	background: backgroundFlag,
	offline: offlineFlag,
	reset: resetFlag,
	onDirtyStore: onDirtyStoreFlag,
	checkpointInterval: checkpointIntervalFlag,
}).pipe(
	Command.withDescription("Start the local ingest + query server (embedded ClickHouse via chDB)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = resolve(Option.getOrUndefined(a.dataDir) ?? defaultDataDir())
			const bindHost = yield* validatedHost("--host / MAPLE_LOCAL_BIND_HOST", a.host)
			// Rejected up front, before anything is opened: a typo that quietly fell
			// back to the default (or worse, to off) would reintroduce the data loss
			// the refresh loop exists to prevent.
			const checkpointInterval = parseCheckpointInterval(a.checkpointInterval)
			if (checkpointInterval === "invalid") {
				return yield* new ServerOptionError({
					source: "--checkpoint-interval",
					message:
						`invalid --checkpoint-interval: ${a.checkpointInterval}; ` +
						"expected a duration like 45s, 30m or 2h, or `off`",
				})
			}
			// `--offline` trusts no hosted origin at all, so none is configured.
			const hostedUiUrl = a.offline ? undefined : yield* remoteUiUrl()
			const advertiseHost = yield* validatedHost(
				"--advertise-host / MAPLE_LOCAL_ADVERTISE_HOST",
				resolveAdvertiseHost(
					Option.getOrUndefined(a.advertiseHost),
					process.env.MAPLE_LOCAL_ADVERTISE_HOST,
					bindHost,
				),
			)
			const scope = commandScope({ dataDir, port: a.port, host: bindHost })
			const pidPath = serverPidPath(dataDir)

			yield* adoptSidecars(dataDir)
			// An older maple running this custom store only knows the legacy PID file.
			if (ownsLegacySidecars(dataDir)) {
				const legacy = yield* readPidSnapshot(legacySidecarPath(dataDir, SERVER_PID_NAME))
				const owner = Option.isSome(legacy) ? yield* pidOwner(legacy.value) : STALE_PID
				if (owner.kind === "live") return yield* alreadyRunning(scope)(owner.pid)
			}

			// Everything below runs under the PID claim. Its finalizers run in
			// reverse registration order on SIGINT/SIGTERM (`BunRuntime.runMain`
			// interrupts the fiber parked on `Effect.never`): stop the checkpoint
			// refresh (awaiting any child), remove the discovery file, stop the
			// listener, close chDB, release the PID file, print "stopped".
			return yield* Effect.scoped(
				Effect.gen(function* () {
					// Only announce "stopped" if we actually started: a startup failure
					// also unwinds this scope.
					let started = false
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							if (started) process.stderr.write(`\n${green("✓")} maple stopped\n`)
						}),
					)

					// Claimed FIRST, before any reconcile, reset, wipe or restore: a
					// second concurrent start must be refused before it can read this
					// start's open sentinel as "dirty" and act on a live store. A
					// `start -d` parent keeps the claim until its child takes it over.
					yield* Effect.acquireRelease(
						claimPidFileExclusive(pidPath, {
							handoverFrom: pidHandoverFrom(),
							busy: alreadyRunning(scope),
						}),
						() => releasePidFile(pidPath),
					)
					// Holding the claim, any discovery file left behind is a dead server's.
					yield* removeStaleDiscovery(dataDir)

					// A taken port fails here, before anything touches the store, rather
					// than after a reset or wipe (or, detached, only in the child's log).
					yield* ensurePortFree(bindHost, a.port)

					// A restore transaction lives beside dataDir and must be reconciled
					// before reset, compatibility, dirty-store, or directory creation logic.
					yield* reconcileCheckpointRecovery(dataDir)

					const migrationIncomplete = yield* Effect.tryPromise({
						try: () => localMigrationIsIncomplete(dataDir),
						catch: (error) =>
							new LocalStoreMigrationError({
								dataDir,
								phase: "read-journal",
								message: `cannot read the local migration journal: ${describeError(error)}`,
							}),
					})
					if (migrationIncomplete && !a.reset) {
						return yield* new LocalStoreMigrationError({
							dataDir,
							phase: "resume",
							message:
								`the local store at ${prettyPath(dataDir)} has an unfinished schema migration; ` +
								`ordinary startup stays fail-closed. Resume it with ` +
								`\`${bold(mapleCommand("schema migrate --yes", scope))}\`. If it cannot proceed and ` +
								`has not started promotion, \`${bold(mapleCommand("schema abandon --yes", scope))}\` ` +
								`returns to the source store and quarantines the staged target.`,
						})
					}
					if (migrationIncomplete) {
						yield* Effect.tryPromise({
							try: () => abandonLocalStoreMigration(dataDir),
							catch: (error) =>
								new LocalStoreMigrationError({
									dataDir,
									phase: "preserve",
									message: `could not preserve the unfinished migration before reset: ${describeError(error)}`,
								}),
						})
					}

					// `--reset`: wipe the store (and its version marker) so we bootstrap
					// fresh. Preserve the checkpoint registry under dataDir/backups.
					if (a.reset) {
						const { preserved } = yield* resetLiveStorePreservingCheckpoints(dataDir)
						yield* reportPreserved(preserved.length, scope)
					}

					// Sampled HERE, not at the point of use: `ensureInitialCheckpoint` runs
					// after `startServer`, and by then chDB has bootstrapped its schema into
					// dataDir, so every store looks like it holds data.
					const storeHadLiveData = yield* storeHasLiveData(dataDir)

					yield* fs.makeDirectory(dataDir, { recursive: true })

					// A downgrade: the store is not stale, this build is. Checked before
					// the chDB-build gate, whose remedy (a reset) would destroy it.
					const newerSchema = newerStoreSchemaVersion(dataDir, CURRENT_LOCAL_SCHEMA.version)
					if (newerSchema !== undefined) {
						return yield* new LocalStoreFromNewerMapleError({
							dataDir,
							storeSchemaVersion: newerSchema,
							currentSchemaVersion: CURRENT_LOCAL_SCHEMA.version,
							message:
								`the local store at ${prettyPath(dataDir)} was written by a newer maple ` +
								`(schema v${newerSchema}; this maple ${MAPLE_VERSION} supports up to ` +
								`v${CURRENT_LOCAL_SCHEMA.version}). Nothing was changed. Reinstall a maple newer than ` +
								`${MAPLE_VERSION} with \`${bold("maple update")}\` (or \`${bold("brew upgrade maple")}\`), ` +
								`or a specific release with \`${bold("maple update --tag <version>")}\`.`,
						})
					}

					// Refuse to open a store written by an incompatible chDB build: re-loading
					// its persisted materialized views crashes the C++ runtime natively
					// (SIGTRAP), which we cannot catch. Fresh/matching stores pass through.
					const compat = checkStoreCompatible(dataDir)
					if (!compat.compatible) {
						return yield* new LocalStoreIncompatibleError({
							dataDir,
							storeBuild: compat.found,
							currentBuild: compat.current,
							message:
								`the local store at ${prettyPath(dataDir)} is incompatible with this build's chDB ` +
								`(store: ${compat.found}; build: ${compat.current}); loading it would crash chDB. ` +
								`If a newer maple wrote it, reinstall that one (\`${bold("maple update")}\`). ` +
								`Otherwise wipe it with \`${bold(mapleCommand("reset", scope))}\`, or start fresh via ` +
								`\`${bold(mapleCommand("start --reset", scope))}\`.`,
						})
					}

					// A store left "open" (the previous server died without running its close
					// finalizer) may be inconsistent: reopening it can crash chDB natively,
					// which we cannot catch. (`--reset` already wiped above, so the marker is gone.)
					if (isStoreDirty(dataDir)) {
						const availability = yield* Effect.promise(() => checkpointAvailability(dataDir))
						if (a.onDirtyStore === "fail") {
							return yield* new LocalStoreDirtyError({
								dataDir,
								policy: "fail",
								checkpointAvailable: availability.available,
								message:
									`the local store at ${prettyPath(dataDir)} was not cleanly closed. ` +
									dirtyStoreRecoveryAdvice(availability, scope),
							})
						}
						if (a.onDirtyStore === "restore-checkpoint") {
							if (!availability.available) {
								return yield* new LocalStoreDirtyError({
									dataDir,
									policy: "restore-checkpoint",
									checkpointAvailable: false,
									message:
										`the local store at ${prettyPath(dataDir)} was not cleanly closed and ` +
										`--on-dirty-store=restore-checkpoint cannot proceed. ` +
										dirtyStoreRecoveryAdvice(availability, scope),
								})
							}
							yield* Effect.sync(() =>
								process.stderr.write(
									amber(
										"⚠ the local store was left inconsistent by an unclean shutdown; " +
											"restoring the last checkpoint\n",
									),
								),
							)
							const restored = yield* restoreCheckpoint(dataDir)
							yield* Effect.sync(() =>
								process.stderr.write(
									`${green("✓")} restored checkpoint; quarantined dirty store at ${prettyPath(restored.quarantinePath)}\n`,
								),
							)
						} else {
							yield* Effect.sync(() =>
								process.stderr.write(
									amber(
										"⚠ the local store was left inconsistent by an unclean shutdown; " +
											"explicit wipe selected, discarding live telemetry while preserving checkpoints\n",
									),
								),
							)
							const { preserved } = yield* resetLiveStorePreservingCheckpoints(dataDir)
							yield* reportPreserved(preserved.length, scope)
							yield* fs.makeDirectory(dataDir, { recursive: true })
						}
					}

					// A store bootstrapped from an older bundled schema can't be evolved in
					// place: `CREATE … IF NOT EXISTS` is a no-op on existing tables. Do not
					// silently delete telemetry or checkpoints: require an explicit choice.
					if (isSchemaIdentityStale(dataDir, CURRENT_LOCAL_SCHEMA)) {
						return yield* new LocalStoreSchemaStaleError({
							dataDir,
							message:
								`the local store at ${prettyPath(dataDir)} was built from a different schema identity. ` +
								`Maple preserved it and its checkpoints. Inspect the supported path with ` +
								`\`${bold(mapleCommand("schema plan", scope))}\`; run ` +
								`\`${bold(mapleCommand("schema migrate --yes", scope))}\` when the printed ` +
								`preservation envelope is acceptable. If no path is registered, use the explicit ` +
								`destructive \`${bold(mapleCommand("start --reset", scope))}\` or ` +
								`\`${bold(mapleCommand("reset --yes", scope))}\`.`,
						})
					}

					const requestedRetentionDays = Option.getOrUndefined(a.minimumRawTelemetryRetentionDays)
					const chdbConfigFile = yield* resolveChdbConfigFile(
						dataDir,
						Option.getOrUndefined(a.chdbConfigFile),
					)

					if (a.background) {
						return yield* startDetached({
							bindHost,
							advertiseHost,
							port: a.port,
							dataDir,
							offline: a.offline,
							hostedUiUrl,
							chdbConfigFile,
							onDirtyStore: a.onDirtyStore,
							minimumRawTelemetryRetentionDays: requestedRetentionDays,
							checkpointInterval: a.checkpointInterval,
							scope,
						})
					}

					yield* Effect.sync(() =>
						process.stderr.write(
							dim(`◌ opening chDB at ${prettyPath(dataDir)} (bootstrapping schema)…\n`),
						),
					)
					const assets = yield* resolveUiAssets()

					const { port: boundPort } = yield* startServer({
						hostname: bindHost,
						browserHosts: Array.from(
							new Set(
								[bindHost, connectionHostForBindHost(bindHost), advertiseHost].map(
									canonicalUrlHostname,
								),
							),
						),
						// None when offline: only the same-origin bundled UI is trusted.
						corsOrigin: hostedUiUrl === undefined ? undefined : hostedUiOrigin(hostedUiUrl),
						advertiseHost,
						port: a.port,
						dataDir,
						configFile: chdbConfigFile,
						minimumRawTelemetryRetentionDays: requestedRetentionDays,
						assets,
					})
					started = true

					const bindAddr = serverUrl(bindHost, boundPort)
					const connectAddr = serverUrl(advertiseHost, boundPort)
					const probeAddr = serverProbeUrl(bindHost, boundPort)
					const boundScope = commandScope({ dataDir, port: boundPort, host: bindHost })

					// Non-fatal: it only helps other CLI processes find a non-default port.
					yield* Effect.acquireRelease(
						Effect.tryPromise({
							try: () =>
								durableWrite(
									serverDiscoveryPath(dataDir),
									`${JSON.stringify(
										{
											pid: process.pid,
											url: probeAddr,
											dataDir,
											startedAt: new Date().toISOString(),
										} satisfies ServerDiscovery,
										null,
										2,
									)}\n`,
								),
							catch: stateFileError(serverDiscoveryPath(dataDir), "write"),
						}).pipe(
							Effect.catch((error) =>
								Effect.sync(() => process.stderr.write(dim(`◌ ${error.message}\n`))),
							),
						),
						() => removeDiscoveryFor(dataDir, process.pid),
					)

					// Default: send users to the auto-updating UI on local.maple.dev (it
					// reaches this binary on loopback via the encoded ?port=). --offline:
					// serve the bundled UI from this origin (only when one is embedded).
					const dashboardUrl =
						hostedUiUrl === undefined
							? assets !== undefined
								? `${connectAddr}/`
								: undefined
							: hostedDashboardUrl(hostedUiUrl, boundPort)
					yield* Effect.sync(() =>
						process.stderr.write(
							startBanner(bindAddr, connectAddr, dataDir, dashboardUrl, a.offline, boundScope),
						),
					)

					const target: CheckpointTarget = {
						dataDir,
						host: connectionHostForBindHost(bindHost),
						port: boundPort,
						scope: boundScope,
					}
					// After the banner, never before it: the server is already listening
					// and the user has their URL. See `ensureInitialCheckpoint`.
					const initialTakenAt = yield* ensureInitialCheckpoint(target, storeHadLiveData)

					// Forked into this scope AFTER the server, so shutdown stops it (and
					// waits out any checkpoint child) before the listener and chDB close.
					if (checkpointInterval !== undefined) {
						yield* Effect.forkScoped(
							checkpointRefreshLoop(target, checkpointInterval, initialTakenAt),
						)
					}

					return yield* Effect.never
				}),
			)
		}),
	),
)

/**
 * How long `maple stop` waits for the server to exit after SIGTERM, and how
 * often it checks. The exiting server flushes telemetry with its own 3s bound
 * and then closes chDB, around 3.5s on a warm laptop, so this leaves headroom
 * for a loaded CI runner.
 */
const STOP_TIMEOUT_MS = 15_000
const STOP_POLL_MS = 100
/** A checkpoint in progress holds the server's JS thread in `BACKUP` and the
 *  shutdown waits for its child, so stop keeps waiting while one runs. */
const STOP_CHECKPOINT_TIMEOUT_MS = 15 * 60_000

const MaintenanceOwner = Schema.Struct({ pid: Schema.Int })
const decodeMaintenanceOwner = Schema.decodeUnknownOption(Schema.fromJsonString(MaintenanceOwner))

/**
 * Is a checkpoint/restore/archive operation running against this store? Read
 * from the maintenance lock's on-disk contract (`<dataDir>.maple-maintenance-lock`,
 * owned by `server/checkpoints.ts`), since the server itself may be too busy
 * in `BACKUP` to answer.
 */
const maintenanceInProgress = (dataDir: string): boolean =>
	Effect.runSync(
		Effect.try({
			try: () => readFileSync(`${resolve(dataDir)}.maple-maintenance-lock/owner.json`, "utf8"),
			catch: (error) => error,
		}).pipe(
			Effect.map((raw) => {
				const owner = decodeMaintenanceOwner(raw)
				return Option.isSome(owner) && isProcessAlive(owner.value.pid)
			}),
			Effect.orElseSucceed(() => false),
		),
	)

/** Does a server that answers for this store report `pid`? The positive
 *  identity check, preferred over the process start-time heuristic. */
const statusConfirmsPid = (
	dataDir: string,
	pid: number,
	scope: CommandScope,
): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const discovery = yield* readDiscovery(dataDir)
		const urls = [
			...(Option.isSome(discovery) && discovery.value.pid === pid ? [discovery.value.url] : []),
			serverProbeUrl(
				scope.host ?? resolveBindHost(process.env.MAPLE_LOCAL_BIND_HOST),
				scope.port ?? 4318,
			),
		]
		for (const url of urls) {
			const status = yield* fetchLocalStatus(url, "1 second")
			if (Option.isSome(status) && status.value.pid === pid) return true
		}
		return false
	})

export const stop = Command.make("stop", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Stop a running `maple start` server"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const dataDir = resolve(Option.getOrUndefined(a.dataDir) ?? defaultDataDir())
			const scope = commandScope({ dataDir })
			const located = yield* locatePidFile(dataDir)

			if (Option.isNone(located)) {
				yield* removeStaleDiscovery(dataDir)
				return yield* new ServerStateError({
					message: `maple is not running for ${prettyPath(dataDir)} (no PID file found)`,
				})
			}
			const { path: pidPath, snapshot } = located.value
			const owner = yield* pidOwner(snapshot)
			if (owner.kind === "stale") {
				const current = yield* readPidSnapshot(pidPath)
				if (Option.isSome(current) && sameSnapshot(current.value, snapshot)) {
					yield* ignoreFailure(() => unlinkSync(pidPath))
				}
				if (snapshot.pid !== undefined) yield* removeDiscoveryFor(dataDir, snapshot.pid)
				return yield* new ServerStateError({
					message: `maple is not running for ${prettyPath(dataDir)} (stale PID file, cleaned up)`,
				})
			}
			const pid = owner.pid

			// After a crash or reboot the PID may belong to anything. Signal it
			// only once it is provably the server that wrote the file.
			const confirmed = (yield* statusConfirmsPid(dataDir, pid, scope)) || owner.verified
			if (!confirmed) {
				return yield* new ServerStateError({
					message:
						`PID ${pid} from ${prettyPath(pidPath)} is alive, but maple could not verify it is the ` +
						`server for ${prettyPath(dataDir)}, so it was not signalled. If it is, stop it with \`kill ${pid}\`.`,
				})
			}

			const checkpointRunning = maintenanceInProgress(dataDir)
			const signalled = yield* Effect.try({
				try: () => {
					process.kill(pid, "SIGTERM")
					return true
				},
				catch: (error) => error,
			}).pipe(Effect.orElseSucceed(() => false))
			yield* Effect.sync(() =>
				process.stderr.write(
					dim(
						`◌ stopping maple (PID ${pid})` +
							(checkpointRunning
								? "; a checkpoint is in progress, waiting for it to finish"
								: ""),
					),
				),
			)

			let waitingNoted = checkpointRunning
			// The ordinary budget restarts once a running checkpoint releases the lock.
			let deadline = STOP_TIMEOUT_MS
			for (let elapsed = 0; signalled; elapsed += STOP_POLL_MS) {
				yield* Effect.sleep(`${STOP_POLL_MS} millis`)
				if (!isProcessAlive(pid)) break
				// One dot per half-second regardless of the poll rate.
				if (elapsed % 500 === 0) yield* Effect.sync(() => process.stderr.write(dim(".")))
				const busy = maintenanceInProgress(dataDir)
				if (busy) deadline = elapsed + STOP_TIMEOUT_MS
				if (busy && !waitingNoted) {
					waitingNoted = true
					yield* Effect.sync(() =>
						process.stderr.write(
							dim("\n◌ a checkpoint is in progress, waiting for it to finish"),
						),
					)
				}
				if (elapsed >= Math.min(deadline, STOP_CHECKPOINT_TIMEOUT_MS)) {
					yield* Effect.sync(() => process.stderr.write("\n"))
					return yield* new ServerStopTimeoutError({
						pid,
						timeoutMs: busy ? STOP_CHECKPOINT_TIMEOUT_MS : STOP_TIMEOUT_MS,
						message: busy
							? `maple (PID ${pid}) is still finishing a checkpoint and exits once it completes; ` +
								`run \`${mapleCommand("stop", scope)}\` again to keep waiting.`
							: `maple did not stop within ${STOP_TIMEOUT_MS / 1000}s. As a last resort, ` +
								`\`kill -9 ${pid}\`; the next start will then find the store not cleanly closed.`,
					})
				}
			}

			const current = yield* readPidSnapshot(pidPath)
			if (Option.isSome(current) && current.value.pid === pid)
				yield* ignoreFailure(() => unlinkSync(pidPath))
			yield* removeDiscoveryFor(dataDir, pid)
			yield* Effect.sync(() => process.stderr.write(`\n${green("✓")} maple stopped\n`))
		}),
	),
)

export const reset = Command.make("reset", { dataDir: dataDirFlag, yes: yesFlag }).pipe(
	Command.withDescription(
		"Delete live chDB data while preserving checkpoints so the next start bootstraps fresh",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const dataDir = resolve(Option.getOrUndefined(a.dataDir) ?? defaultDataDir())
			const scope = commandScope({ dataDir })
			yield* adoptSidecars(dataDir)

			// Refuse while a server still owns the store.
			yield* refuseIfRunning(dataDir, runningRefusal(scope))

			// Deleting a store is irreversible: require explicit confirmation, and
			// exit non-zero without it so `maple reset && maple start` stops here.
			if (!a.yes) {
				return yield* new ServerStateError({
					message:
						`This permanently deletes live telemetry at ${bold(prettyPath(dataDir))}.\n` +
						`The checkpoint registry under its backups directory is preserved.\n` +
						`Re-run with ${bold(mapleCommand("reset --yes", scope))} to confirm.`,
				})
			}

			return yield* Effect.scoped(
				Effect.gen(function* () {
					// Held for the whole reset so no `start` can open the store mid-wipe.
					yield* Effect.acquireRelease(
						claimPidFileExclusive(serverPidPath(dataDir), { busy: runningRefusal(scope) }),
						() => releasePidFile(serverPidPath(dataDir)),
					)
					const abandonedMigration = yield* Effect.tryPromise({
						try: () => abandonLocalStoreMigration(dataDir),
						catch: (error) =>
							new LocalStoreMigrationError({
								dataDir,
								phase: "preserve",
								message: `could not preserve the unfinished migration before reset: ${describeError(error)}`,
							}),
					})
					const { preserved } = yield* resetLiveStorePreservingCheckpoints(dataDir)
					yield* Effect.sync(() =>
						process.stderr.write(
							`${green("✓")} reset: cleared live data at ${prettyPath(dataDir)}\n` +
								(abandonedMigration === null
									? ""
									: `${dim("  migration")} preserved at ${prettyPath(abandonedMigration)}\n`),
						),
					)
					yield* reportPreserved(preserved.length, scope)
				}),
			)
		}),
	),
)

export const checkpoint = Command.make("checkpoint", {
	dataDir: dataDirFlag,
	host: checkpointHost,
	port: checkpointPort,
}).pipe(
	Command.withDescription("Create and validate a restorable checkpoint of the local chDB store"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const dataDir = resolve(Option.getOrUndefined(a.dataDir) ?? defaultDataDir())
			const result = yield* createCheckpoint({
				dataDir,
				host: connectionHostForBindHost(a.host),
				port: a.port,
			})
			// Status on stderr like every lifecycle command; stdout is reserved for
			// machine output (`--format json`).
			if (jsonFormatRequested()) {
				return yield* writeJson({
					checkpointId: result.checkpointId,
					path: result.path,
					validation: result.manifest.validation,
				})
			}
			yield* Effect.sync(() =>
				process.stderr.write(
					`${green("✓")} checkpoint created\n` +
						`  ${dim("id")}        ${result.checkpointId}\n` +
						`  ${dim("path")}      ${prettyPath(result.path)}\n` +
						`  ${dim("traces")}    ${result.manifest.validation.traces}\n` +
						`  ${dim("logs")}      ${result.manifest.validation.logs}\n` +
						`  ${dim("metrics")}   ${result.manifest.validation.metricsSum}\n` +
						`  ${dim("views")}     ${result.manifest.validation.materializedViews}\n`,
				),
			)
		}),
	),
)

export const restore = Command.make("restore", {
	dataDir: dataDirFlag,
	checkpointId: checkpointIdFlag,
	yes: yesFlag,
}).pipe(
	Command.withDescription("Restore the local chDB store from the last promoted checkpoint"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const dataDir = resolve(Option.getOrUndefined(a.dataDir) ?? defaultDataDir())
			const scope = commandScope({ dataDir })
			yield* adoptSidecars(dataDir)

			yield* refuseIfRunning(dataDir, runningRefusal(scope))

			const rawCheckpointId = Option.getOrUndefined(a.checkpointId)
			const checkpointId = yield* Effect.try({
				try: () => (rawCheckpointId === undefined ? "current" : parseCheckpointId(rawCheckpointId)),
				catch: (error) =>
					new ServerOptionError({ source: "--checkpoint-id", message: describeError(error) }),
			})

			if (!a.yes) {
				const confirm = mapleCommand(
					`restore --yes${rawCheckpointId === undefined ? "" : ` --checkpoint-id ${checkpointId}`}`,
					scope,
				)
				return yield* new ServerStateError({
					message:
						`This replaces the local store at ${bold(prettyPath(dataDir))} with ` +
						`${rawCheckpointId === undefined ? "the last checkpoint" : `checkpoint ${checkpointId}`}.\n` +
						`The existing store is moved aside for quarantine, not deleted.\n` +
						`Re-run with ${bold(confirm)} to confirm.`,
				})
			}

			return yield* Effect.scoped(
				Effect.gen(function* () {
					yield* Effect.acquireRelease(
						claimPidFileExclusive(serverPidPath(dataDir), { busy: runningRefusal(scope) }),
						() => releasePidFile(serverPidPath(dataDir)),
					)
					// Finish a restore a crash interrupted BEFORE looking for checkpoints:
					// between its two renames the registry is not at dataDir/backups, and
					// this would report "no checkpoint" for a store that has one.
					yield* reconcileCheckpointRecovery(dataDir)

					// Fail fast, and legibly, when there is nothing to restore.
					const availability = yield* Effect.promise(() => checkpointAvailability(dataDir))
					if (!availability.available) {
						return yield* new CheckpointUnavailableError({
							dataDir,
							reason: availability.reason,
							message:
								availability.reason === "none"
									? `no checkpoint exists under ${prettyPath(dataDir)}; nothing to restore. ` +
										`Checkpoints are created by \`${bold(mapleCommand("checkpoint", scope))}\` while the server is running. ` +
										`To start over from an unreadable store, use \`${bold(mapleCommand("start --reset", scope))}\`.`
									: `the checkpoint registry under ${prettyPath(dataDir)} is unusable: ${availability.detail}. ` +
										`Preserve it for inspection, or start over with \`${bold(mapleCommand("start --reset", scope))}\`.`,
						})
					}

					const result = yield* restoreCheckpoint(dataDir, checkpointId)
					if (jsonFormatRequested()) {
						return yield* writeJson({
							checkpointId: result.checkpointId,
							quarantinePath: result.quarantinePath,
							validation: result.validation,
						})
					}
					yield* Effect.sync(() =>
						process.stderr.write(
							`${green("✓")} restored checkpoint\n` +
								`  ${dim("id")}         ${result.checkpointId}\n` +
								`  ${dim("quarantine")} ${prettyPath(result.quarantinePath)}\n` +
								`  ${dim("traces")}     ${result.validation.traces}\n` +
								`  ${dim("logs")}       ${result.validation.logs}\n` +
								`  ${dim("metrics")}    ${result.validation.metricsSum}\n` +
								`  ${dim("views")}      ${result.validation.materializedViews}\n`,
						),
					)
				}),
			)
		}),
	),
)
