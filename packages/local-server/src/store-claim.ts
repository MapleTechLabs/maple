// Ownership of a local store: the PID file that serializes every process
// opening it, with stale-claim takeover and legacy-sidecar adoption.
import { Clock, Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { errnoCode, type ServerStateFileError, stateFileError } from "./store-errors"
import {
	adoptLegacySidecars,
	legacySidecarPath,
	ownsLegacySidecars,
	SERVER_PID_NAME,
	serverPidPath,
} from "./store-version"

// ---------------------------------------------------------------------------
// Process liveness: is the owner named by a PID file still that process?
// ---------------------------------------------------------------------------

/** Parse `ps -o etime=` (`[[dd-]hh:]mm:ss`) into whole seconds. */
export const parseElapsedSeconds = (raw: string): number | undefined => {
	const match = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
	if (!match) return undefined
	const [, days, hours, minutes, seconds] = match
	return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/**
 * Start time of a Linux process from `/proc/<pid>/stat` (field 22, ticks since
 * boot) and `/proc/stat` (`btime`), for images that ship no `ps`. Fields are
 * counted after the last `)` because the command name may hold spaces and parens.
 */
export const parseProcStartedAtMs = (pidStat: string, systemStat: string): number | undefined => {
	const commEnd = pidStat.lastIndexOf(")")
	// `state` is field 3, so `starttime` (field 22) is index 19 after the comm.
	const ticks = pidStat.slice(commEnd + 2).split(" ")[19] ?? ""
	const boot = systemStat.match(/^btime (\d+)$/m)
	if (commEnd < 0 || !boot || !/^\d+$/.test(ticks)) return undefined
	// /proc reports times in USER_HZ, which the kernel ABI fixes at 100 per second.
	return Number(boot[1]) * 1000 + Number(ticks) * 10
}

/**
 * Could a live process that started at `startedAtMs` have written a PID file
 * last modified at `writtenAtMs`? A reused PID belongs to a process started
 * after the writer died, so after the write. The slack covers `etime`'s
 * whole-second resolution.
 */
export const startedBeforeWrite = (startedAtMs: number, writtenAtMs: number): boolean =>
	startedAtMs <= writtenAtMs + 2_000

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

// ---------------------------------------------------------------------------
// PID file: the one claim that serializes every process opening a store.
// ---------------------------------------------------------------------------

export interface PidFileSnapshot {
	readonly raw: string
	readonly pid: number | undefined
	readonly ino: number
	readonly mtimeMs: number
}

export const readPidSnapshot = (path: string): Effect.Effect<Option.Option<PidFileSnapshot>> =>
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

export const sameSnapshot = (a: PidFileSnapshot, b: PidFileSnapshot): boolean =>
	a.raw === b.raw && a.ino === b.ino && a.mtimeMs === b.mtimeMs

/** Wall-clock start of a live process from `/proc`, on Linux. */
const procStartedAtMs = (pid: number): Effect.Effect<Option.Option<number>> =>
	Effect.try({
		try: () =>
			parseProcStartedAtMs(
				readFileSync(`/proc/${pid}/stat`, "utf8"),
				readFileSync("/proc/stat", "utf8"),
			),
		catch: (error) => error,
	}).pipe(
		Effect.map(Option.fromUndefinedOr),
		Effect.orElseSucceed(() => Option.none<number>()),
	)

const psStartedAtMs = (pid: number): Effect.Effect<Option.Option<number>> =>
	Effect.try({
		try: () =>
			Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }),
		catch: (error) => error,
	}).pipe(
		Effect.flatMap((result) => {
			const seconds = result.success ? parseElapsedSeconds(result.stdout.toString()) : undefined
			return seconds === undefined
				? Effect.succeed(Option.none<number>())
				: Effect.map(Clock.currentTimeMillis, (nowMs) => Option.some(nowMs - seconds * 1000))
		}),
		Effect.orElseSucceed(() => Option.none<number>()),
	)

/** Wall-clock start of a live process (`/proc`, else `ps -o etime=`), when it can be known.
 *  `/proc` first: slim and distroless container images ship no `ps`. */
const processStartedAtMs = (pid: number): Effect.Effect<Option.Option<number>> =>
	procStartedAtMs(pid).pipe(
		Effect.flatMap((startedAt) =>
			Option.isSome(startedAt) ? Effect.succeed(startedAt) : psStartedAtMs(pid),
		),
	)

export type PidOwner =
	| { readonly kind: "stale" }
	/** `verified`: the process provably started before the file was written. */
	| { readonly kind: "live"; readonly pid: number; readonly verified: boolean }

export const STALE_PID: PidOwner = { kind: "stale" }
const livePid = (pid: number, verified: boolean): PidOwner => ({ kind: "live", pid, verified })

/**
 * Does the process named by a PID file still own it? After a crash or reboot
 * the number may belong to an unrelated process, which necessarily started
 * after the file was written. Without `/proc` or `ps` the answer is "live, unverified",
 * the conservative reading for every caller.
 */
export const pidOwner = (snapshot: PidFileSnapshot): Effect.Effect<PidOwner> =>
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

export const ignoreFailure = (thunk: () => void): Effect.Effect<void> =>
	Effect.try({ try: thunk, catch: (error) => error }).pipe(Effect.ignore)

/**
 * Remove a stale PID file without ever deleting a claim that a concurrent
 * start published after we read it: move it aside, and only discard it if it
 * is byte-for-byte the file we judged stale; otherwise put it back and yield.
 */
const takeOverStalePidFile = <E>(
	path: string,
	observed: PidFileSnapshot,
	busy: (pid: number | undefined) => E,
): Effect.Effect<void, E | ServerStateFileError> =>
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
		return yield* Effect.fail(busy(Option.isSome(current) ? current.value.pid : undefined))
	})

/**
 * Exclusively claim the PID file so exactly one `start`, `reset` or `restore`
 * touches the store. A stale file (dead or reused PID) is taken over safely.
 * `handoverFrom` lets a `start -d` child inherit its parent's claim; `busy`
 * builds the host's refusal when another live process holds it.
 */
export const claimPidFileExclusive = <E>(
	pidPath: string,
	options: {
		readonly handoverFrom?: number | undefined
		readonly busy: (pid: number | undefined) => E
	},
): Effect.Effect<void, E | ServerStateFileError> =>
	Effect.gen(function* () {
		const { busy } = options
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
				return yield* Effect.fail(busy(owner.pid))
			}
			yield* takeOverStalePidFile(pidPath, observed.value, busy)
		}
		return yield* Effect.fail(busy(undefined))
	})

/** Remove the PID file only while it still names this process. */
export const releasePidFile = (pidPath: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const current = yield* readPidSnapshot(pidPath)
		if (Option.isSome(current) && current.value.pid === process.pid) {
			yield* ignoreFailure(() => unlinkSync(pidPath))
		}
	})

/** The PID file of the server that owns `dataDir`: the current-layout one, or
 *  the one an older maple wrote for a custom `--data-dir` before upgrading. */
export const locatePidFile = (
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
export const refuseIfRunning = <E>(
	dataDir: string,
	refusal: (pid: number | undefined) => E,
): Effect.Effect<void, E> =>
	Effect.gen(function* () {
		const located = yield* locatePidFile(dataDir)
		if (Option.isNone(located)) return
		const owner = yield* pidOwner(located.value.snapshot)
		if (owner.kind === "live") return yield* Effect.fail(refusal(owner.pid))
	})

/** Explicit adoption of pre-namespacing state files; returns what it adopted. */
export const adoptLegacyStoreFiles = (
	dataDir: string,
): Effect.Effect<ReadonlyArray<string>, ServerStateFileError> =>
	Effect.try({
		try: () => adoptLegacySidecars(dataDir),
		catch: stateFileError(dataDir, "adopt the legacy state files beside"),
	})

/** Own `dataDir` until the scope closes, with the same protocol as `maple start`. */
export const acquireStoreClaim = <E>(dataDir: string, busy: (pid: number | undefined) => E) =>
	Effect.gen(function* () {
		yield* adoptLegacyStoreFiles(dataDir)
		yield* refuseIfRunning(dataDir, busy)
		yield* Effect.acquireRelease(claimPidFileExclusive(serverPidPath(dataDir), { busy }), () =>
			releasePidFile(serverPidPath(dataDir)),
		)
	})
