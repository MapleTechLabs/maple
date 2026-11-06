import { randomBytes, timingSafeEqual } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs"
import { Effect, Schema, String as Str } from "effect"
import { durableFileError, durableWrite } from "./durable-files"
import { errnoCode } from "./store-errors"

/** A credential or ledger path that is a symlink or a non-file; refused rather than followed. */
export class LocalFileNotReal extends Schema.TaggedError<LocalFileNotReal>()("@maple/cli/LocalFileNotReal", {
	message: Schema.String,
	path: Schema.String,
}) {}

/** A credential owned by another user or open to group/other; refused rather than trusted. */
export class LocalFileNotPrivate extends Schema.TaggedError<LocalFileNotPrivate>()(
	"@maple/cli/LocalFileNotPrivate",
	{ message: Schema.String, path: Schema.String },
) {}

export const readRealFile = (path: string, label: string): string => {
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new LocalFileNotReal({ message: `${label} is not a real file: ${path}`, path })
	return readFileSync(path, "utf8")
}

/** Why `stat` is not private to this user, or undefined. Windows has no POSIX owner or mode. */
export const notPrivateReason = (
	stat: Pick<Stats, "uid" | "mode">,
	uid: number | undefined,
): string | undefined => {
	if (uid === undefined) return undefined
	if (stat.uid !== uid) return `is owned by uid ${stat.uid}, not this user (uid ${uid})`
	const mode = stat.mode & 0o777
	return (mode & 0o077) === 0 ? undefined : `has mode ${mode.toString(8)}, which lets group/other access it`
}

// O_NOFOLLOW refuses a symlink; O_NONBLOCK keeps a planted FIFO from blocking the open.
const PRIVATE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** Reads a credential only when it is a regular file owned by this user and closed to everyone else. */
const readPrivateFile = (path: string, label: string): string =>
	Effect.runSync(
		Effect.acquireUseRelease(
			Effect.try({
				try: () => openSync(path, PRIVATE_READ_FLAGS),
				catch: (cause) =>
					errnoCode(cause) === "ELOOP"
						? new LocalFileNotReal({ message: `${label} is not a real file: ${path}`, path })
						: durableFileError(path, `open ${label}`)(cause),
			}),
			(fd) =>
				Effect.gen(function* () {
					const stat = fstatSync(fd)
					if (!stat.isFile())
						return yield* new LocalFileNotReal({
							message: `${label} is not a real file: ${path}`,
							path,
						})
					const reason = notPrivateReason(stat, process.getuid?.())
					if (reason !== undefined)
						return yield* new LocalFileNotPrivate({
							message: `${label} ${path} ${reason}; remove it or restrict it to its owner (chmod 600)`,
							path,
						})
					return readFileSync(fd, "utf8")
				}),
			(fd) => Effect.sync(() => closeSync(fd)),
		),
	)

export const ensureLocalToken = async (path: string, label: string): Promise<string> => {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined)
		await durableWrite(path, `${randomBytes(32).toString("hex")}\n`)
	const token = Str.trim(readPrivateFile(path, label))
	return Schema.decodeSync(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)))(token)
}

export const localTokenMatches = (expected: string, supplied: string | null): boolean => {
	if (supplied === null) return false
	const left = Buffer.from(expected)
	const right = Buffer.from(supplied)
	return left.length === right.length && timingSafeEqual(left, right)
}
