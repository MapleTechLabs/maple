import { Schema } from "effect"

// Failures any host hits while claiming or opening a local store. The tags keep
// their `@maple/cli/` prefix: the CLI's exit handling and its telemetry group
// failures by tag, and these are the same failures `maple start` has always raised.

export const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

export const errnoCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined

export const stateFileError =
	(path: string, action: string) =>
	(error: unknown): ServerStateFileError =>
		new ServerStateFileError({ path, message: `could not ${action} ${path}: ${describeError(error)}` })

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

/** A PID, discovery, or legacy state file beside the data dir could not be read or written. */
export class ServerStateFileError extends Schema.TaggedError<ServerStateFileError>()(
	"@maple/cli/ServerStateFileError",
	{ path: Schema.String, message: Schema.String },
) {}

/** The dirty-store policy in force when the store turned out to be unclean. */
export const DirtyStorePolicy = Schema.Literals(["fail", "restore-checkpoint", "reset"])

/**
 * The store was left open by a server that died without closing chDB. Reopening
 * it can crash chDB natively, so startup refuses.
 *
 * `checkpointAvailable` is the field worth grouping on: without a checkpoint
 * there is nothing to restore and the only way forward is `--reset`, which is a
 * materially different user experience from the recoverable case.
 */
export class LocalStoreDirtyError extends Schema.TaggedError<LocalStoreDirtyError>()(
	"@maple/cli/LocalStoreDirtyError",
	{
		dataDir: Schema.String,
		policy: DirtyStorePolicy,
		checkpointAvailable: Schema.Boolean,
		message: Schema.String,
	},
) {}

/** The store was written by a different chDB build; loading it would SIGTRAP. */
export class LocalStoreIncompatibleError extends Schema.TaggedError<LocalStoreIncompatibleError>()(
	"@maple/cli/LocalStoreIncompatibleError",
	{
		dataDir: Schema.String,
		storeBuild: Schema.String,
		currentBuild: Schema.String,
		message: Schema.String,
	},
) {}

/** The store was bootstrapped from an older bundled schema and needs migrating. */
export class LocalStoreSchemaStaleError extends Schema.TaggedError<LocalStoreSchemaStaleError>()(
	"@maple/cli/LocalStoreSchemaStaleError",
	{ dataDir: Schema.String, message: Schema.String },
) {}

/**
 * The store's marker records a schema version newer than this build knows: a
 * downgrade. Distinct from a stale schema because the remedy is reinstalling
 * the newer maple, never a reset.
 */
export class LocalStoreFromNewerMapleError extends Schema.TaggedError<LocalStoreFromNewerMapleError>()(
	"@maple/cli/LocalStoreFromNewerMapleError",
	{
		dataDir: Schema.String,
		storeSchemaVersion: Schema.Number,
		currentSchemaVersion: Schema.Number,
		message: Schema.String,
	},
) {}

/** Which part of the local-store migration journal the command was doing. */
export const MigrationPhase = Schema.Literals(["read-journal", "resume", "preserve"])

/** An unfinished schema migration blocks startup, or its journal is unreadable. */
export class LocalStoreMigrationError extends Schema.TaggedError<LocalStoreMigrationError>()(
	"@maple/cli/LocalStoreMigrationError",
	{ dataDir: Schema.String, phase: MigrationPhase, message: Schema.String },
) {}
