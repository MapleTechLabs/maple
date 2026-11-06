/**
 * Guarded status transitions: the UPDATE carries the state the writer read, so a concurrent
 * transition wins and the late writer sees a typed conflict instead of overwriting it.
 */
import { Array as Arr, Effect, Schema } from "effect"

export class TransitionConflictError extends Schema.TaggedError<TransitionConflictError>()(
	"@maple/backend/TransitionConflictError",
	{
		message: Schema.String,
		table: Schema.String,
		id: Schema.String,
		expected: Schema.Array(Schema.String),
		target: Schema.String,
	},
) {}

export interface TransitionRowOptions<S extends string> {
	/** Table name, for the error and logs. */
	readonly table: string
	readonly id: string
	/** The states the writer read; the UPDATE only applies while the row is still in one of them. */
	readonly from: Arr.NonEmptyReadonlyArray<S>
	readonly to: S
}

/**
 * `write` must guard on `<status> IN (from)` plus org and id, with RETURNING. No row back fails
 * with {@link TransitionConflictError}; callers remap it (a 409) or catch it as a no-op.
 */
export const transitionRow = <S extends string, Row, E, R>(
	options: TransitionRowOptions<S>,
	write: (from: Arr.NonEmptyReadonlyArray<S>) => Effect.Effect<ReadonlyArray<Row>, E, R>,
): Effect.Effect<Row, E | TransitionConflictError, R> =>
	Effect.flatMap(write(options.from), (rows) => {
		const [row] = rows
		if (row !== undefined) return Effect.succeed(row)
		return Effect.fail(
			new TransitionConflictError({
				message: `${options.table} '${options.id}' is no longer in ${Arr.join(options.from, " or ")}; it did not move to '${options.to}'.`,
				table: options.table,
				id: options.id,
				expected: options.from,
				target: options.to,
			}),
		)
	})
