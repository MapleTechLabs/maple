import { Schema } from "effect"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { DEFAULT_LOCAL_PORT, normalizeHost, resolveBindHost } from "../lib/local-address"

export type DirtyStorePolicy = "wipe" | "fail" | "restore-checkpoint"

export {
	canonicalUrlHostname,
	connectionHostForBindHost,
	defaultLocalUrl,
	hostedDashboardUrl,
	hostedUiOrigin,
	resolveAdvertiseHost,
	resolveBindHost,
	serverProbeUrl,
	serverUrl,
	validateHost,
} from "../lib/local-address"

export const defaultDataDir = (): string => join(homedir(), ".maple", "data")

/** Collapse the home directory to `~` for tidy paths. */
export const prettyPath = (p: string): string => {
	const home = homedir()
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

/** Quote a value for a pasteable shell command; plain words stay bare. */
export const shellWord = (value: string): string =>
	/^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`

/**
 * The non-default target flags of the invocation that printed a hint. Every
 * suggested command must carry them: `maple reset --yes` pasted from a
 * `--data-dir X` run would otherwise wipe the DEFAULT store.
 */
export interface CommandScope {
	readonly dataDir?: string
	readonly port?: number
	readonly host?: string
}

type CommandScopeDraft = { -readonly [K in keyof CommandScope]: CommandScope[K] }

export const commandScope = (options: {
	readonly dataDir: string
	readonly port?: number
	readonly host?: string
}): CommandScope => {
	const scope: CommandScopeDraft = {}
	if (resolve(options.dataDir) !== resolve(defaultDataDir())) scope.dataDir = resolve(options.dataDir)
	if (options.port !== undefined && options.port !== DEFAULT_LOCAL_PORT) scope.port = options.port
	const host = options.host === undefined ? undefined : normalizeHost(options.host)
	if (host !== undefined && host !== resolveBindHost(process.env.MAPLE_LOCAL_BIND_HOST)) scope.host = host
	return scope
}

/** Which scope flags each subcommand accepts; the others would be rejected. */
const SCOPE_FLAGS = {
	start: ["dataDir", "port", "host"],
	checkpoint: ["dataDir", "port", "host"],
	stop: ["dataDir"],
	reset: ["dataDir"],
	restore: ["dataDir"],
	schema: ["dataDir"],
} satisfies Record<string, ReadonlyArray<keyof CommandScope>>

const acceptedScopeFlags = (subcommand: string): ReadonlyArray<keyof CommandScope> =>
	Object.entries(SCOPE_FLAGS).find(([name]) => name === subcommand)?.[1] ?? []

const dataDirWord = (dataDir: string): string =>
	shellWord(prettyPath(dataDir)) === prettyPath(dataDir) ? prettyPath(dataDir) : shellWord(dataDir)

/** `maple <args>` plus the scope flags that subcommand accepts. */
export const mapleCommand = (args: string, scope: CommandScope): string => {
	const accepted = acceptedScopeFlags(args.split(" ")[0] ?? "")
	const flags = [
		...(accepted.includes("dataDir") && scope.dataDir !== undefined
			? [`--data-dir ${dataDirWord(scope.dataDir)}`]
			: []),
		...(accepted.includes("port") && scope.port !== undefined ? [`--port ${scope.port}`] : []),
		...(accepted.includes("host") && scope.host !== undefined ? [`--host ${shellWord(scope.host)}`] : []),
	]
	return ["maple", args, ...flags].join(" ")
}

/** Env var through which a `start -d` parent hands its PID-file claim to the
 * child it spawns, so the store is never unclaimed between the two. */
export const PID_HANDOVER_ENV = "MAPLE_INTERNAL_PID_HANDOVER"

/** `GET /local/status`, served by a running `maple start`. */
export const LocalStatus = Schema.Struct({
	service: Schema.Literal("maple-local"),
	pid: Schema.Int,
	version: Schema.String,
	url: Schema.String,
	dataDir: Schema.String,
	lastIngestAtMs: Schema.NullOr(Schema.Number),
})
export type LocalStatus = typeof LocalStatus.Type

/** `<sidecar>/maple-server.json`, written once a server is listening. */
export const ServerDiscovery = Schema.Struct({
	pid: Schema.Int,
	url: Schema.String,
	dataDir: Schema.String,
	startedAt: Schema.String,
})
export type ServerDiscovery = typeof ServerDiscovery.Type

/** Parse `ps -o etime=` (`[[dd-]hh:]mm:ss`) into whole seconds. */
export const parseElapsedSeconds = (raw: string): number | undefined => {
	const match = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
	if (!match) return undefined
	const [, days, hours, minutes, seconds] = match
	return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/**
 * Could a live process that started at `startedAtMs` have written a PID file
 * last modified at `writtenAtMs`? A reused PID belongs to a process started
 * after the writer died, so after the write. The slack covers `etime`'s
 * whole-second resolution.
 */
export const startedBeforeWrite = (startedAtMs: number, writtenAtMs: number): boolean =>
	startedAtMs <= writtenAtMs + 2_000

/** Does telemetry ingested since `sinceMs` need a fresh checkpoint? Unknown
 * ingest state (`undefined`) always does. */
export const ingestedSince = (lastIngestAtMs: number | null | undefined, sinceMs: number): boolean =>
	lastIngestAtMs === undefined || (lastIngestAtMs !== null && lastIngestAtMs >= sinceMs)

export interface DetachedChildArgs {
	readonly entry: string | undefined
	readonly host: string
	readonly advertiseHost: string
	readonly port: number
	readonly dataDir: string
	readonly offline: boolean
	readonly chdbConfigFile: string | undefined
	readonly onDirtyStore: DirtyStorePolicy
	readonly minimumRawTelemetryRetentionDays: number | undefined
	/** Raw `--checkpoint-interval` text, forwarded verbatim so the child parses
	 *  and validates it exactly as the parent did. */
	readonly checkpointInterval: string
}

/** Build the foreground child argv without forwarding compiled-Bun virtual
 * entrypoints or the background flag that caused the re-exec. */
export const buildDetachedChildArgs = (options: DetachedChildArgs): string[] => {
	const runtimeArgs = options.entry && !options.entry.startsWith("/$bunfs") ? [options.entry] : []
	return [
		...runtimeArgs,
		"start",
		"--host",
		options.host,
		"--advertise-host",
		options.advertiseHost,
		"--port",
		String(options.port),
		"--data-dir",
		options.dataDir,
		"--on-dirty-store",
		options.onDirtyStore,
		// Forwarded explicitly: the child re-parses its own flags, so omitting this
		// would silently drop the user's cadence (and `--checkpoint-interval off`
		// would come back as the default) on every `--background` start.
		"--checkpoint-interval",
		options.checkpointInterval,
		...(options.chdbConfigFile ? ["--chdb-config-file", options.chdbConfigFile] : []),
		...(options.minimumRawTelemetryRetentionDays !== undefined
			? ["--minimum-raw-telemetry-retention-days", String(options.minimumRawTelemetryRetentionDays)]
			: []),
		...(options.offline ? ["--offline"] : []),
	]
}

/**
 * Argv for a `maple checkpoint` CHILD process.
 *
 * The child posts `BACKUP` to this server's `/local/checkpoint/backup` and then
 * validates the result in its own chDB process, holding the maintenance lock
 * throughout; the server's chDB connection cannot host that second step.
 *
 * `entry` follows the same rule as `buildDetachedChildArgs`: a Bun-compiled
 * binary injects a virtual `/$bunfs/...` entrypoint that must not be forwarded.
 */
export const buildCheckpointChildArgs = (options: {
	readonly entry: string | undefined
	readonly host: string
	readonly port: number
	readonly dataDir: string
}): string[] => [
	...(options.entry && !options.entry.startsWith("/$bunfs") ? [options.entry] : []),
	"checkpoint",
	"--host",
	options.host,
	"--port",
	String(options.port),
	"--data-dir",
	options.dataDir,
]

/** Liveness probe via signal 0: a process primitive with no FileSystem
 *  equivalent. Never throws (errors mean "not alive").
 *
 *  A PID file naming *this* process is stale by definition: the previous server
 *  is the one that wrote it, so if its number is ours it has died and the OS
 *  reused the PID. In a container that is the common case, not the edge case:
 *  `maple start` is PID 1 on every restart, the file survives on the data
 *  volume, and `kill(1, 0)` always succeeds, so without this check a container
 *  whose server died once refuses to start forever ("already running (PID 1)").
 *  Non-positive PIDs are rejected for the same reason: `kill(0, 0)` and
 *  `kill(-n, 0)` signal process groups and "succeed" for a group that exists. */
export const isProcessAlive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}
