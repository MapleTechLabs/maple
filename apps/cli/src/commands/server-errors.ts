import { Schema } from "effect"

/**
 * Failures of `start`/`stop`/`reset`/`checkpoint`/`restore`, one tag per situation so telemetry
 * groups them apart. `message` is the remedy the user reads; errors with their own tag
 * (`ServerBindError`, `CheckpointRestoreError`) are not re-wrapped here.
 */

/** A flag or environment variable the CLI cannot use as given. */
export class ServerOptionError extends Schema.TaggedError<ServerOptionError>()(
	"@maple/cli/ServerOptionError",
	{
		/** Which input was rejected: `--host`, `MAPLE_LOCAL_UI_URL`, `--checkpoint-id`. */
		source: Schema.String,
		message: Schema.String,
	},
) {}

/** Why no checkpoint could be selected: none was ever taken, another build took it, or the registry is unusable. */
export const CheckpointUnavailableReason = Schema.Literals(["none", "other_build", "unusable"])

/**
 * `maple restore` with nothing to restore from. Its own tag because it is the
 * dead end `maple start`'s dirty-store advice used to send people into, and
 * telling the two reasons apart is the whole point of looking at it.
 */
export class CheckpointUnavailableError extends Schema.TaggedError<CheckpointUnavailableError>()(
	"@maple/cli/CheckpointUnavailableError",
	{ dataDir: Schema.String, reason: CheckpointUnavailableReason, message: Schema.String },
) {}

/** `maple start --background` could not spawn the detached child at all. */
export class BackgroundServerSpawnError extends Schema.TaggedError<BackgroundServerSpawnError>()(
	"@maple/cli/BackgroundServerSpawnError",
	{ logPath: Schema.String, message: Schema.String },
) {}

/**
 * The detached child was spawned but never reported ready (its own PID from
 * `/local/status`). Distinct from the spawn failure: the child's own failure is
 * in its log, so this error points there rather than pretending to know the cause.
 */
export class BackgroundServerTimeoutError extends Schema.TaggedError<BackgroundServerTimeoutError>()(
	"@maple/cli/BackgroundServerTimeoutError",
	{ logPath: Schema.String, timeoutMs: Schema.Number, message: Schema.String },
) {}

/** The detached child exited before it was ready; its own error is in the log. */
export class BackgroundServerExitedError extends Schema.TaggedError<BackgroundServerExitedError>()(
	"@maple/cli/BackgroundServerExitedError",
	{ logPath: Schema.String, exitCode: Schema.NullOr(Schema.Number), message: Schema.String },
) {}

/** `maple stop` sent SIGTERM and the server was still alive when the budget ran out. */
export class ServerStopTimeoutError extends Schema.TaggedError<ServerStopTimeoutError>()(
	"@maple/cli/ServerStopTimeoutError",
	{ pid: Schema.Number, timeoutMs: Schema.Number, message: Schema.String },
) {}

/**
 * A spawned `maple checkpoint` child that did not succeed.
 *
 * Both the opening checkpoint and the refresh loop take checkpoints by spawning
 * that command rather than calling into chDB, so this is where their failures
 * land. Never fatal (the server keeps serving), but tagged and carrying the
 * child's own stderr, because a silently failing loop leaves a store that only
 * turns out to have no restore point when it finally matters.
 */
export class CheckpointChildError extends Schema.TaggedError<CheckpointChildError>()(
	"@maple/cli/CheckpointChildError",
	{
		/** `initial` (opening checkpoint) or `refresh` (the interval loop). */
		reason: Schema.Literals(["initial", "refresh"]),
		exitCode: Schema.Number,
		message: Schema.String,
	},
) {}
