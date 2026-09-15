import { assert, describe, it } from "@effect/vitest"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause } from "effect"
import {
	ConnectionError,
	DeadlockError,
	SqlError,
	SqlSyntaxError,
	UniqueViolation,
} from "effect/unstable/sql/SqlError"
import { DatabaseError, toDatabaseError } from "./DatabaseLive"
import {
	isPostgresConnectionError,
	isRetryablePostgresContention,
	postgresErrorType,
	postgresSqlState,
} from "./postgres-errors"

/** A pg error the way node-postgres raises it: the class hangs off `code`. */
const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** A statement failure the way drizzle's effect session raises it. */
const queryFailure = (query: string, reason: SqlError["reason"]): EffectDrizzleQueryError =>
	new EffectDrizzleQueryError({ query, params: [], cause: Cause.fail(new SqlError({ reason })) })

describe("postgresErrorType", () => {
	it("reports the socket code for a dial that was refused", () => {
		const error = toDatabaseError(
			new SqlError({
				reason: new ConnectionError({
					cause: pgError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:5432"),
					message: "Connection error",
					operation: "acquireConnection",
				}),
			}),
		)
		assert.strictEqual(postgresErrorType(error), "ECONNREFUSED")
		assert.isTrue(isPostgresConnectionError(error))
		// A connection failure has no SQLSTATE — nothing was ever executed.
		assert.isUndefined(postgresSqlState(error))
		// The socket's own message leads, not the classification's.
		assert.strictEqual(error.message, "connect ECONNREFUSED 10.0.0.1:5432")
	})

	it("falls back to the reason's class for a dial that timed out without a code", () => {
		// node-postgres reports `connectionTimeoutMillis` as a bare Error.
		const error = toDatabaseError(
			new SqlError({
				reason: new ConnectionError({
					cause: new Error("timeout exceeded when trying to connect"),
					message: "Connection error",
					operation: "acquireConnection",
				}),
			}),
		)
		assert.strictEqual(postgresErrorType(error), "ConnectionError")
		assert.isTrue(isPostgresConnectionError(error))
	})

	it("reports SQLSTATE for a statement failure, root cause first", () => {
		const error = toDatabaseError(
			queryFailure(
				'insert into "api_keys" ("id") values ($1)',
				new UniqueViolation({
					cause: pgError("23505", 'duplicate key value violates unique constraint "api_keys_pkey"'),
					constraint: "api_keys_pkey",
				}),
			),
		)
		assert.strictEqual(postgresErrorType(error), "23505")
		assert.strictEqual(postgresSqlState(error), "23505")
		// The distinction the flattened message could not carry: this is the query
		// failing, not the connection.
		assert.isFalse(isPostgresConnectionError(error))
		assert.strictEqual(
			error.message,
			'duplicate key value violates unique constraint "api_keys_pkey" [while: insert into "api_keys" ("id") values ($1)]',
		)
		assert.instanceOf(error.cause, EffectDrizzleQueryError)
	})

	it("caps the statement in the message and keeps it out of the diagnostic", () => {
		const longQuery = `insert into "error_events" values ${"($1),".repeat(400)}`
		const error = toDatabaseError(
			queryFailure(
				longQuery,
				new SqlSyntaxError({ cause: pgError("42601", "syntax error at end of input") }),
			),
		)
		assert.match(error.message, /^syntax error at end of input \[while: insert into/)
		assert.include(error.message, "…[truncated")
		assert.isBelow(error.message.length, 800)
	})

	it("unwraps a legacy driver code nested one level down", () => {
		const outer = new Error("Failed query", { cause: pgError("ECONNRESET", "socket hang up") })
		const error = toDatabaseError(outer)
		assert.strictEqual(postgresErrorType(error), "ECONNRESET")
		assert.isTrue(isPostgresConnectionError(error))
	})

	it("falls back to the error name when there is no code", () => {
		const named = new Error("something else")
		named.name = "PostgresError"
		assert.strictEqual(postgresErrorType(toDatabaseError(named)), "PostgresError")
	})

	it("returns undefined for a bare Error rather than inventing a class", () => {
		assert.isUndefined(postgresErrorType(toDatabaseError(new Error("boom"))))
		assert.isFalse(isPostgresConnectionError(toDatabaseError(new Error("boom"))))
	})

	it("treats the driver's deadlock classification as retryable contention", () => {
		const deadlock = toDatabaseError(
			queryFailure(
				'update "alert_rule_claims" …',
				new DeadlockError({ cause: pgError("40P01", "deadlock detected") }),
			),
		)
		assert.isTrue(isRetryablePostgresContention(deadlock))
		// Contention is a statement failure, not a connection one — a retry there
		// must not be counted against the dial budget.
		assert.isFalse(isPostgresConnectionError(deadlock))
	})

	it("leaves legacy contention classification unchanged", () => {
		const deadlock = toDatabaseError(pgError("40P01", "deadlock detected"))
		assert.isTrue(isRetryablePostgresContention(deadlock))
	})

	it("does not treat a connection failure as retryable contention", () => {
		const error = new DatabaseError({
			message: "connect ECONNREFUSED",
			cause: pgError("ECONNREFUSED", "connect ECONNREFUSED"),
		})
		assert.isFalse(isRetryablePostgresContention(error))
	})
})
