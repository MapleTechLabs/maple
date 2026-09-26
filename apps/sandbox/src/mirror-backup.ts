/**
 * Carrying a repository's mirror across container sleeps.
 *
 * A container's disk goes when it sleeps, so without this every cold container re-clones the
 * whole history. The mirror is archived to R2 through the Sandbox SDK's backup API, the handle
 * kept in the Sandbox Durable Object's own storage (one object per repository per organization,
 * and it outlives the container), and a cold container restores it before its first clone: the
 * clone script then copies the seed into place and fetches only what changed since.
 *
 * Kept apart from `worker.ts`, like `checkout.ts`, so it runs without a Workers runtime: the
 * Durable Object arrives as a {@link MirrorBackupHost}.
 */
import { SANDBOX_MIRROR_DIR, SANDBOX_SEED_DIR, SANDBOX_SNAPSHOT_DIR, shellQuote } from "@maple/domain/sandbox"
import { Duration, Effect, Option, Schema } from "effect"
import { snapshotScript } from "./checkout"

/** Where the latest backup's handle lives in the Durable Object's storage. */
export const MIRROR_BACKUP_KEY = "maple:mirror-backup"

/**
 * How stale a backup may get before the next ready checkout replaces it. A restore fetches
 * everything since, so this bounds that fetch; archiving more often only spends container CPU.
 */
export const MIRROR_BACKUP_REFRESH = Duration.hours(24)

/**
 * How long R2 keeps an archive. Longer than the refresh so an active repository always has one,
 * short enough that a disconnected repository's source does not sit in R2 for long.
 */
export const MIRROR_BACKUP_TTL = Duration.days(7)

/** The bound on a restore, which sits in the path of a clone. Past it the clone starts from scratch. */
export const MIRROR_RESTORE_TIMEOUT = Duration.seconds(30)

export class StoredMirrorBackup extends Schema.Class<StoredMirrorBackup>("StoredMirrorBackup")({
	id: Schema.String,
	createdAt: Schema.Number,
}) {}

/** Storage hands back whatever was written, possibly by an older deploy; decoded where it is read. */
export const decodeStoredMirrorBackup = Schema.decodeUnknownOption(StoredMirrorBackup)

export class MirrorBackupError extends Schema.TaggedError<MirrorBackupError>()(
	"@maple/sandbox/MirrorBackupError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The slice of the Sandbox Durable Object this module drives. */
export interface MirrorBackupHost {
	/** False when the Worker has no bucket or no R2 credentials: backups are off, clones still work. */
	readonly configured: boolean
	readonly exec: (command: string) => Promise<{ readonly exitCode: number; readonly stderr: string }>
	readonly createBackup: (options: {
		readonly dir: string
		readonly name: string
		readonly ttl: number
	}) => Promise<{ readonly id: string }>
	readonly restoreBackup: (backup: { readonly id: string; readonly dir: string }) => Promise<void>
	/** The latest backup's handle from the Durable Object's storage, decoded. */
	readonly readBackup: () => Promise<Option.Option<StoredMirrorBackup>>
	readonly writeBackup: (backup: StoredMirrorBackup) => Promise<void>
	readonly forgetBackup: () => Promise<void>
	readonly now: () => number
}

const call = <A>(what: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new MirrorBackupError({
				message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
				cause,
			}),
	})

const stored = (host: MirrorBackupHost) => call("read the backup handle", () => host.readBackup())

/** The SDK's errors for an archive that no longer exists or is past its TTL. */
const GONE: ReadonlySet<string> = new Set(["BackupNotFoundError", "BackupExpiredError"])

const errorName = (cause: unknown): string => (cause instanceof Error ? cause.name : "")

export type RestoreOutcome = "unconfigured" | "none" | "present" | "restored" | "expired"

/**
 * Restore the latest mirror backup to the seed path, if this container has neither a mirror nor
 * a seed yet. The clone script does the rest; a failure here only costs a full fetch.
 */
export const restoreMirror = (host: MirrorBackupHost): Effect.Effect<RestoreOutcome, MirrorBackupError> =>
	Effect.gen(function* () {
		if (!host.configured) return "unconfigured"
		const backup = yield* stored(host)
		if (Option.isNone(backup)) return "none"
		if (host.now() - backup.value.createdAt >= Duration.toMillis(MIRROR_BACKUP_TTL)) {
			yield* call("forget an expired backup", () => host.forgetBackup())
			return "expired"
		}
		const present = yield* call("look for a mirror", () =>
			host.exec(
				`test -d ${shellQuote(SANDBOX_MIRROR_DIR)}/objects || test -d ${shellQuote(SANDBOX_SEED_DIR)}/objects`,
			),
		)
		if (present.exitCode === 0) return "present"
		const gone = yield* call("restore the mirror", () =>
			host.restoreBackup({ id: backup.value.id, dir: SANDBOX_SEED_DIR }),
		).pipe(
			Effect.as(false),
			// R2 lost the archive or it aged out: forget it, or every cold container would try again.
			Effect.catchIf(
				(error) => GONE.has(errorName(error.cause)),
				() => call("forget a missing backup", () => host.forgetBackup()).pipe(Effect.as(true)),
			),
			Effect.timeoutOrElse({
				duration: MIRROR_RESTORE_TIMEOUT,
				orElse: () =>
					Effect.fail(
						new MirrorBackupError({
							message: `restoring the mirror took over ${Duration.toSeconds(MIRROR_RESTORE_TIMEOUT)}s`,
						}),
					),
			}),
		)
		return gone ? "expired" : "restored"
	})

export type BackupOutcome = "unconfigured" | "fresh" | "no-mirror" | "created"

/**
 * Archive the mirror if the last archive is older than {@link MIRROR_BACKUP_REFRESH}.
 *
 * Archives a hard-link snapshot rather than the mirror itself, so a fetch that starts meanwhile
 * cannot leave a half-written ref or a lock file in the archive for a later restore to trip on.
 */
export const backupMirror = (host: MirrorBackupHost): Effect.Effect<BackupOutcome, MirrorBackupError> =>
	Effect.gen(function* () {
		if (!host.configured) return "unconfigured"
		const previous = yield* stored(host)
		if (
			Option.isSome(previous) &&
			host.now() - previous.value.createdAt < Duration.toMillis(MIRROR_BACKUP_REFRESH)
		)
			return "fresh"
		const snapshot = yield* call("snapshot the mirror", () => host.exec(snapshotScript()))
		if (snapshot.exitCode === 3) return "no-mirror"
		if (snapshot.exitCode !== 0)
			return yield* new MirrorBackupError({
				message: `snapshot the mirror: exit ${snapshot.exitCode}: ${snapshot.stderr.trim().slice(0, 500)}`,
			})
		const createdAt = host.now()
		const backup = yield* call("archive the mirror", () =>
			host.createBackup({
				dir: SANDBOX_SNAPSHOT_DIR,
				name: "maple-mirror",
				ttl: Duration.toSeconds(MIRROR_BACKUP_TTL),
			}),
		).pipe(
			Effect.ensuring(
				call("remove the snapshot", () =>
					host.exec(`rm -rf ${shellQuote(SANDBOX_SNAPSHOT_DIR)}`),
				).pipe(Effect.ignore),
			),
		)
		yield* call("store the backup handle", () =>
			host.writeBackup(new StoredMirrorBackup({ id: backup.id, createdAt })),
		)
		return "created"
	})
