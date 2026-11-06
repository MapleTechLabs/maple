/**
 * Guarded status transitions for the implicit state machines in Postgres.
 *
 * A writer that read a row's state earlier and then wrote `UPDATE ... WHERE id = ?`
 * silently overwrote any transition that landed in between. The fix is to guard
 * the UPDATE on the state the writer read and treat "no row came back" as a lost race.
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
 * Run a guarded transition. `write` receives the expected states and must put them in its
 * `WHERE <status> IN (...)` alongside the org and id, with a RETURNING clause: the returned row
 * is the transitioned one, and an empty result fails with {@link TransitionConflictError}.
 *
 * Callers either remap the conflict (an API caller's 409) or catch it as a no-op where losing
 * is fine (a sweep, a late writer whose result no longer applies).
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
