import { isMapleDbError, type MapleDb, type MapleDbError, MapleStatementCollector } from "@maple/db/client"
import { fingerprintSql, SQL_TRACE_MAX, summarizeSql, truncateSql } from "@maple/query-engine/execution"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Clock, Context, Effect, Result, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import {
	driverRootError,
	driverSqlError,
	isPostgresConnectionError,
	postgresErrorType,
	postgresSqlState,
} from "./postgres-errors"
import { updateCurrentSpanName } from "./span-name"

export type DatabaseClient = MapleDb

/**
 * `cause` is the driver's own error, kept for `postgres-errors.ts` to read the
 * classification and SQLSTATE off. It is `Schema.Defect()` rather than
 * `Schema.Unknown` for the reason the convention gives: `Unknown` has no
 * encoded form, so anything that serialized a `DatabaseError` serialized the
 * raw driver object — host, port, driver options and all. `Defect()` encodes an
 * `Error` to its `name` and `message`, and `excludeCause: true` stops at the
 * driver error instead of walking into the socket error underneath it.
 * `toDatabaseError` already lifts the root cause's message into `message`, so
 * the diagnostic half survives the narrowing.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("@maple/api/lib/DatabaseError", {
	message: Schema.String,
	cause: Schema.Defect({ excludeCause: true }),
}) {}

/**
 * What a `Database.execute` call fails with: the driver's own failures are
 * absorbed into `DatabaseError` at this boundary, everything the callback
 * failed with on its own passes through untouched. Spelled through `Extract`
 * because that is exactly what the `catchIf` refinement in `executeWithSpan`
 * produces; for a concrete `E` it reads as `DatabaseError | <the rest>`.
 */
export type ExecuteError<E> = DatabaseError | Exclude<E, Extract<E, MapleDbError>>

export interface DatabaseApi {
	readonly execute: <A, E, R>(
		fn: (db: MapleDb) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, ExecuteError<E>, R>
}

/**
 * Callback handed to an `executeWithSpan` body so it can report what only it
 * knows: transport-level attributes discovered along the way. Statements are
 * collected without its help, through `MapleStatementCollector`.
 */
export interface ExecuteHooks {
	/** Merge extra attributes into the span at annotate time. */
	readonly record: (attributes: Record<string, unknown>) => void
}

/**
 * A batched upsert of error rows runs to tens of KB of SQL. Span status and log
 * lines truncate, so whatever comes first is what survives.
 */
const MAX_QUERY_MESSAGE_CHARS = 600

const capQueryMessage = (message: string): string =>
	message.length <= MAX_QUERY_MESSAGE_CHARS
		? message
		: `${message.slice(0, MAX_QUERY_MESSAGE_CHARS)}…[truncated ${message.length - MAX_QUERY_MESSAGE_CHARS} chars]`

/**
 * Root cause first: the Postgres diagnostic (`invalid byte sequence for
 * encoding "UTF8": 0x00`, `relation "x" does not exist`) is the half an
 * operator needs, and the half that used to sit past the truncation point
 * behind the quoted statement. The statement follows, capped — the full SQL is
 * on the span as `db.query.text`.
 */
export const toDatabaseError = (cause: unknown): DatabaseError => {
	if (cause instanceof EffectDrizzleQueryError) {
		const statement = capQueryMessage(cause.query)
		const root = driverRootError(cause)?.message
		return new DatabaseError({
			message: root ? `${root} [while: ${statement}]` : statement,
			// Never the drizzle error itself: its `message` getter interpolates the
			// bound params, and `Schema.Defect` encodes `message`.
			cause: driverSqlError(cause) ?? new Error(`Failed query: ${statement}`),
		})
	}
	if (cause instanceof SqlError) {
		return new DatabaseError({ message: driverRootError(cause)?.message ?? cause.message, cause })
	}
	const message = cause instanceof Error ? cause.message : "Database operation failed"
	const rootCause = cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : undefined
	return new DatabaseError({
		message: rootCause ? `${rootCause} [while: ${capQueryMessage(message)}]` : capQueryMessage(message),
		cause,
	})
}

/** The driver failure a Cause carries as a defect, if it is one. */
const driverDefect = <E>(cause: Cause.Cause<E>): MapleDbError | undefined => {
	const defect = Cause.findDefect(cause)
	return Result.isSuccess(defect) && isMapleDbError(defect.success) ? defect.success : undefined
}

/**
 * Absorb the driver's failures into `DatabaseError`; whatever else the callback
 * failed with passes through.
 *
 * Defects too: `@effect/sql`'s transaction wrapper `orDie`s a failed COMMIT or
 * ROLLBACK (a deferred constraint at commit, a connection that dropped before
 * the rollback), so without this the failure would skip contention retry, the
 * service's error mapping and the span's `error.type`.
 */
const absorbDriverErrors = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, ExecuteError<E>, R> =>
	self.pipe(
		// Type arguments pinned: left to inference, TypeScript picks an `orElse`
		// success type that leaks `E` into the success channel.
		Effect.catchIf<E, Extract<E, MapleDbError>, never, DatabaseError, never>(
			(error): error is Extract<E, MapleDbError> => isMapleDbError(error),
			(error) => Effect.fail(toDatabaseError(error)),
		),
		// Only a driver defect is caught; any other defect keeps its original Cause,
		// and an interrupted call whose ROLLBACK died stays interrupted.
		Effect.catchCauseIf(
			(cause) => !Cause.hasInterrupts(cause) && driverDefect(cause) !== undefined,
			(cause) => Effect.fail(toDatabaseError(driverDefect(cause))),
		),
	)

/** Shared by both entry points below so the two can never describe different origins. */
const DB_SPAN_OPTIONS = {
	kind: "client",
	attributes: {
		"db.system.name": "postgresql",
		"peer.service": "planetscale-postgres",
	},
} as const

/**
 * A `Database.execute` span for a call refused before any statement could run.
 *
 * The refusal is decided in Effect, so it fails in Effect. It still gets a
 * span: a call that reached `Database.execute` and was turned away is exactly
 * the thing an operator needs to see, and a silent `Effect.fail` would leave
 * the trace looking as though it never happened. `db.query.*` is absent on
 * purpose — there is no statement.
 */
export const failExecuteWithSpan = Effect.fn(
	"Database.execute",
	DB_SPAN_OPTIONS,
)(function* (error: DatabaseError, extraAttributes?: Record<string, unknown>) {
	if (extraAttributes) {
		yield* Effect.annotateCurrentSpan(extraAttributes)
	}
	return yield* Effect.fail(error)
})

/**
 * Wraps one Database.execute call in a Client-kind span per Maple's telemetry
 * conventions (db.system.name + peer.service power the service-map DB edge;
 * db.query.text feeds the query-shapes panel). A fresh statement collector is
 * provided around `run`, so every parameterized statement the call issues
 * (including inside transactions) lands in `db.query.text`, and concurrent
 * calls over the same database never cross-attribute. The identity attributes
 * live on the span declaration, not the success path, so failed calls still
 * produce map edges.
 *
 * `"Database.execute"` is only the *placeholder* name: OTel wants a DB client
 * span named after its query, so once the SQL is known the span is renamed to
 * `db.query.summary` ("SELECT alert_rules"). See `span-name.ts`. A call that
 * fails before issuing any statement keeps the placeholder.
 *
 * `peer.service` is `planetscale-postgres` — the same value `apps/ingest` emits
 * for the same origin database, so the two paths don't produce divergent
 * service-map targets (MAP-01 in the maple-audit skill).
 *
 * `@effect/sql` opens a span of its own per statement. Those are suppressed
 * here: this span already carries the statement text, and the API traces
 * itself, so a second span per statement would double the volume of the
 * busiest edge in the internal org for nothing new.
 *
 * There is no connect/query split. The pool dials on the first statement, so
 * there is no separate connect phase to time. What that split was used to
 * infer, `error.type` states outright: a stalled dial and a constraint
 * violation are different classes, not different durations.
 */
export const executeWithSpan = Effect.fn(
	"Database.execute",
	DB_SPAN_OPTIONS,
)(function* <A, E, R>(
	run: (hooks: ExecuteHooks) => Effect.Effect<A, E, R>,
	extraAttributes?: Record<string, unknown>,
) {
	if (extraAttributes) {
		yield* Effect.annotateCurrentSpan(extraAttributes)
	}
	const statements: Array<string> = []
	const recorded: Record<string, unknown> = {}
	const startedMs = yield* Clock.currentTimeMillis
	// Shared by the success and error paths — tapError runs inside the span,
	// so a failing statement still carries its SQL and timing.
	const annotate = Effect.gen(function* () {
		const sqlText = statements.join(";\n")
		// Summarize the joined text, not the first statement alone: that is
		// exactly the input the warehouse would derive a shape label from, so the
		// emitted summary can never disagree with the fallback derivation.
		const { operation, collection, summary } = summarizeSql(sqlText)
		yield* Effect.annotateCurrentSpan({
			...recorded,
			"db.query.text": truncateSql(sqlText, SQL_TRACE_MAX),
			"db.query.length": sqlText.length,
			"db.query.truncated": sqlText.length > SQL_TRACE_MAX,
			"db.query.fingerprint": fingerprintSql(sqlText),
			"db.statement_count": statements.length,
			"db.duration_ms": (yield* Clock.currentTimeMillis) - startedMs,
		})
		if (summary !== "") {
			yield* Effect.annotateCurrentSpan("db.query.summary", summary)
			yield* updateCurrentSpanName(summary)
		}
		if (operation !== "") {
			yield* Effect.annotateCurrentSpan("db.operation.name", operation)
		}
		if (collection !== "") {
			yield* Effect.annotateCurrentSpan("db.collection.name", collection)
		}
	})
	// `error.type` is what separates a stalled dial from a constraint violation
	// once the span lands — the message alone cannot, since `toDatabaseError`
	// flattens the driver's classification into prose. `db.response.status_code`
	// carries SQLSTATE where there is one, per OTel's database conventions.
	const annotateFailure = (error: DatabaseError) =>
		Effect.gen(function* () {
			const errorType = postgresErrorType(error)
			if (errorType !== undefined) {
				yield* Effect.annotateCurrentSpan("error.type", errorType)
			}
			const sqlState = postgresSqlState(error)
			if (sqlState !== undefined) {
				yield* Effect.annotateCurrentSpan("db.response.status_code", sqlState)
			}
			yield* Effect.annotateCurrentSpan("db.connect.failed", isPostgresConnectionError(error))
			yield* annotate
		})
	const result = yield* run({
		record: (attributes) => Object.assign(recorded, attributes),
	}).pipe(
		Effect.provideService(MapleStatementCollector, (query) => {
			statements.push(query)
		}),
		Effect.withTracerEnabled(false),
		absorbDriverErrors,
		Effect.tapError((error) => (error instanceof DatabaseError ? annotateFailure(error) : annotate)),
	)
	yield* annotate
	if (Array.isArray(result)) {
		// `db.response.returned_rows` is what the span-detail database panel reads
		// (packages/ui/src/lib/cloud-platforms/database.ts); `result.rowCount` is
		// Maple's own key, also emitted by the warehouse executor. Keep both.
		yield* Effect.annotateCurrentSpan({
			"result.rowCount": result.length,
			"db.response.returned_rows": result.length,
		})
	}
	return result
})

export class Database extends Context.Service<Database, DatabaseApi>()("@maple/api/services/Database") {}
