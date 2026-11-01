import { Clock, Effect, Option } from "effect"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SERVER_PID_NAME } from "@maple/local-server/store-version"
import { isProcessAlive } from "@maple/local-server/store-claim"
import { ServerStateFileError } from "@maple/local-server/store-errors"

/**
 * `maple start --in-memory`: a throwaway store for one run.
 *
 * chDB has no RAM-only disk for MergeTree (ClickHouse dropped the `memory` disk
 * type) and the C API has no `:memory:` path, so the store is a temp directory
 * deleted on exit. On Linux it goes on tmpfs (`/dev/shm`) when that has room,
 * which keeps it in RAM; elsewhere the OS temp dir, mostly page cache at these
 * sizes.
 */
export const IN_MEMORY_STORE_PREFIX = "maple-in-memory-"

/** Docker caps `/dev/shm` at 64 MiB by default, too small to hold telemetry. */
export const MIN_TMPFS_FREE_BYTES = 1024 * 1024 * 1024

/** A dir this young may belong to a start that has not claimed its PID file yet. */
export const ABANDONED_STORE_MIN_AGE_MS = 60_000

const TMPFS_DIR = "/dev/shm"

export interface InMemoryStore {
	/** The temp root holding the store and its sidecars. Removed on release. */
	readonly root: string
	/** The chDB `--path`. Named `data` so every sidecar lands inside {@link root}. */
	readonly dataDir: string
	/** True when {@link root} is on tmpfs. */
	readonly tmpfs: boolean
}

const freeBytes = (dir: string): Effect.Effect<Option.Option<number>> =>
	Effect.try({
		try: () => {
			const stats = statfsSync(dir)
			return stats.bavail * stats.bsize
		},
		catch: (error) => error,
	}).pipe(Effect.option)

/** Where the temp root goes: tmpfs on Linux when it has room, else the OS temp dir. */
export const inMemoryStoreParent = (
	platform: NodeJS.Platform = process.platform,
	tmpfsFree: (dir: string) => Effect.Effect<Option.Option<number>> = freeBytes,
): Effect.Effect<{ readonly dir: string; readonly tmpfs: boolean }> =>
	Effect.gen(function* () {
		if (platform !== "linux") return { dir: tmpdir(), tmpfs: false }
		const free = yield* tmpfsFree(TMPFS_DIR)
		return Option.exists(free, (bytes) => bytes >= MIN_TMPFS_FREE_BYTES)
			? { dir: TMPFS_DIR, tmpfs: true }
			: { dir: tmpdir(), tmpfs: false }
	})

/**
 * Is this store root left behind by a run that died without cleaning up
 * (`kill -9`, a crash)? A root whose owner is alive, or that is too young to
 * have claimed its PID file, is kept.
 */
export const isAbandonedStore = (
	owner: Option.Option<number>,
	ageMs: number,
	alive: (pid: number) => boolean = isProcessAlive,
): boolean =>
	Option.match(owner, {
		onNone: () => ageMs >= ABANDONED_STORE_MIN_AGE_MS,
		onSome: (pid) => !alive(pid),
	})

/** The PID in a store root's `maple.pid`, when it holds one. */
const ownerPid = (root: string): Effect.Effect<Option.Option<number>> =>
	Effect.try({
		try: () => Number.parseInt(readFileSync(join(root, SERVER_PID_NAME), "utf8").trim(), 10),
		catch: (error) => error,
	}).pipe(Effect.option, Effect.map(Option.filter((pid) => Number.isInteger(pid) && pid > 0)))

const isAbandonedRoot = (root: string, nowMs: number): Effect.Effect<boolean> =>
	Effect.try({ try: () => statSync(root).mtimeMs, catch: (error) => error }).pipe(
		Effect.flatMap((mtimeMs) =>
			Effect.map(ownerPid(root), (owner) => isAbandonedStore(owner, nowMs - mtimeMs)),
		),
		Effect.orElseSucceed(() => false),
	)

const removeTree = (path: string): Effect.Effect<void> =>
	Effect.try({
		try: () => rmSync(path, { recursive: true, force: true }),
		catch: (error) => error,
	}).pipe(Effect.ignore)

/** Delete in-memory stores under `parent` whose server is gone. Never fails. */
export const sweepAbandonedStores = (parent: string): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const nowMs = yield* Clock.currentTimeMillis
		const names = yield* Effect.try({ try: () => readdirSync(parent), catch: (error) => error }).pipe(
			Effect.orElseSucceed((): Array<string> => []),
		)
		const abandoned = yield* Effect.filter(
			names.filter((name) => name.startsWith(IN_MEMORY_STORE_PREFIX)).map((name) => join(parent, name)),
			(root) => isAbandonedRoot(root, nowMs),
		)
		yield* Effect.forEach(abandoned, removeTree, { discard: true })
		return abandoned
	})

/** Every dir an in-memory store can live in on this platform. */
export const sweepParents = (platform: NodeJS.Platform = process.platform): ReadonlyArray<string> =>
	platform === "linux" ? [TMPFS_DIR, tmpdir()] : [tmpdir()]

const DISCOVERY_FILE = /^in-memory-(\d+)\.maple-server\.json$/

/** An in-memory server's discovery file: its store's sidecars vanish with it,
 *  so the file goes where query commands look (`~/.maple/*.maple-server.json`). */
export const inMemoryDiscoveryPath = (dir: string, pid: number): string =>
	join(dir, `in-memory-${pid}.maple-server.json`)

/** The `dataDir` key for an in-memory server's start-failure record. The
 *  store's own sidecars vanish on exit, which would reset every failure streak
 *  and defeat the backoff; this lands it at `<dir>/in-memory.start-failures.json`. */
export const inMemoryStartFailuresKey = (dir: string): string => join(dir, "in-memory")

/** Delete in-memory discovery files under `dir` whose server is gone. Never fails. */
export const sweepStaleDiscoveryFiles = (
	dir: string,
	alive: (pid: number) => boolean = isProcessAlive,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const names = yield* Effect.try({ try: () => readdirSync(dir), catch: (error) => error }).pipe(
			Effect.orElseSucceed((): Array<string> => []),
		)
		const stale = names.flatMap((name) => {
			const pid = DISCOVERY_FILE.exec(name)?.[1]
			return pid !== undefined && !alive(Number(pid)) ? [join(dir, name)] : []
		})
		yield* Effect.forEach(stale, removeTree, { discard: true })
		return stale
	})

/**
 * Create a fresh in-memory store, deleted when the scope closes. Acquire it
 * before chDB opens so the release runs after chDB has closed. First removes
 * what killed runs left: stores, and discovery files in `discoveryDir`.
 */
export const acquireInMemoryStore = (discoveryDir: string) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const parent = yield* inMemoryStoreParent()
			// Both candidates: a killed run may have used the other one (tmpfs filled up).
			yield* Effect.forEach(sweepParents(), sweepAbandonedStores, { discard: true })
			yield* sweepStaleDiscoveryFiles(discoveryDir)
			const root = yield* Effect.try({
				try: () => mkdtempSync(join(parent.dir, IN_MEMORY_STORE_PREFIX)),
				catch: (error) =>
					new ServerStateFileError({
						path: parent.dir,
						message: `could not create an in-memory store under ${parent.dir}: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})
			return { root, dataDir: join(root, "data"), tmpfs: parent.tmpfs } satisfies InMemoryStore
		}),
		(store) => removeTree(store.root),
	)

/** Flags that only make sense for a store that outlives the process. */
export const inMemoryConflicts = (flags: {
	readonly background: boolean
	readonly dataDir: boolean
	readonly reset: boolean
	readonly minimumRawTelemetryRetentionDays: boolean
	readonly checkpointIntervalSet: boolean
	readonly onDirtyStoreSet: boolean
}): ReadonlyArray<string> =>
	[
		flags.background ? "--background" : undefined,
		flags.dataDir ? "--data-dir" : undefined,
		flags.reset ? "--reset" : undefined,
		flags.minimumRawTelemetryRetentionDays ? "--minimum-raw-telemetry-retention-days" : undefined,
		flags.checkpointIntervalSet ? "--checkpoint-interval" : undefined,
		flags.onDirtyStoreSet ? "--on-dirty-store" : undefined,
	].filter((flag): flag is string => flag !== undefined)
