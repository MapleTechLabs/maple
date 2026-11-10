// Whether a PID names a live process: the one probe every store lock, PID file and
// discovery file check shares.
import { Effect, String as Str } from "effect"
import { readFileSync } from "node:fs"
import { errnoCode, syscallError } from "./store-errors"

/** Liveness probe via signal 0: a process primitive with no FileSystem
 *  equivalent. Never throws. EPERM means the process exists under another user.
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
	return Effect.runSync(
		Effect.try({ try: () => process.kill(pid, 0), catch: syscallError }).pipe(
			Effect.as(true),
			Effect.catch((error) => Effect.succeed(errnoCode(error.cause) === "EPERM")),
		),
	)
}

/** The PID a PID file names when that process is alive; a missing or unreadable file reads as none. */
export const livePidInFile = (path: string): number | undefined =>
	Effect.runSync(
		Effect.try({ try: () => readFileSync(path, "utf8"), catch: syscallError }).pipe(
			Effect.map((raw) => Number.parseInt(Str.trim(raw), 10)),
			Effect.map((pid) => (isProcessAlive(pid) ? pid : undefined)),
			Effect.orElseSucceed(() => undefined),
		),
	)
