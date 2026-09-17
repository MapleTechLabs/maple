// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Option } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { DatabaseError } from "./DatabaseLive"

const RETRYABLE_CONTENTION_CODES: ReadonlySet<string> = new Set(["40001", "40P01"])
const RETRYABLE_CONTENTION_MESSAGE = /\b(?:40001|40P01)\b/
/** `@effect/sql`'s classification of the same two SQLSTATEs. */
const RETRYABLE_CONTENTION_REASONS: ReadonlySet<string> = new Set(["DeadlockError", "SerializationError"])

const causeCode = (cause: unknown): string | undefined => {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
	const code = (cause as { readonly code?: unknown }).code
	return typeof code === "string" ? code : undefined
}

const causeMessage = (cause: unknown): string | undefined => {
	if (cause instanceof Error) return cause.message
	return typeof cause === "string" ? cause : undefined
}

/**
 * `@effect/sql`'s classification of a driver failure, when the error carries
 * one. A statement failure arrives as `EffectDrizzleQueryError` whose `cause`
 * is a `Cause<SqlError>`; transaction control fails with a bare `SqlError`.
 * Anything else — a scope refusal, a test double — has no reason.
 */
export const driverReason = (cause: unknown): SqlError["reason"] | undefined => {
	if (cause instanceof SqlError) return cause.reason
	if (cause instanceof EffectDrizzleQueryError) {
		const inner: unknown = cause.cause
		if (Cause.isCause(inner)) {
			const failure = Cause.findErrorOption(inner)
			return Option.isSome(failure) ? driverReason(failure.value) : undefined
		}
		return driverReason(inner)
	}
	return undefined
}

/**
 * The pg error underneath the classification — the half an operator needs
 * (`relation "x" does not exist`) and the SQLSTATE the span reports.
 */
export const driverRootError = (
	cause: unknown,
): { readonly code: string | undefined; readonly message: string | undefined } | undefined => {
	const reason = driverReason(cause)
	if (reason === undefined) return undefined
	return { code: causeCode(reason.cause), message: causeMessage(reason.cause) ?? reason.message }
}

/** PostgreSQL failures that are safe to retry as a fresh transaction attempt. */
export const isRetryablePostgresContention = (error: DatabaseError): boolean => {
	if (RETRYABLE_CONTENTION_MESSAGE.test(error.message)) return true
	const reason = driverReason(error.cause)
	if (reason !== undefined && RETRYABLE_CONTENTION_REASONS.has(reason._tag)) return true
	const code = errorCode(error)
	if (code !== undefined && RETRYABLE_CONTENTION_CODES.has(code)) return true
	const innerMessage = causeMessage(error.cause)
	return innerMessage !== undefined && RETRYABLE_CONTENTION_MESSAGE.test(innerMessage)
}

/**
 * Socket-level codes for failures to establish or keep a connection, as
 * opposed to failures of a statement. node-postgres surfaces the socket's own
 * code; a dial that hit `connectionTimeoutMillis` or a dropped socket carries
 * none, and `@effect/sql-pg` only tags SQLSTATE `08*` as `ConnectionError`, so
 * those are recognised by node-postgres's own message instead.
 */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
	"CONNECT_TIMEOUT",
	"CONNECTION_CLOSED",
	"CONNECTION_DESTROYED",
	"CONNECTION_ENDED",
	"CONNECTION_REFUSED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
])

/** SQLSTATE: five alphanumerics, e.g. `23505`, `40001`, `57014`. */
const SQLSTATE = /^[0-9A-Z]{5}$/

/** node-postgres / pg-pool messages for code-less connection failures. */
const CODELESS_CONNECTION_MESSAGE = /Connection terminated|timeout exceeded when trying to connect/

/** A connection-class driver failure: tagged `ConnectionError`, or code-less with a connection message. */
const isConnectionReason = (cause: unknown): boolean => {
	const reason = driverReason(cause)
	if (reason === undefined) return false
	if (reason._tag === "ConnectionError") return true
	const root = driverRootError(cause)
	return (
		root?.code === undefined &&
		root?.message !== undefined &&
		CODELESS_CONNECTION_MESSAGE.test(root.message)
	)
}

const nestedCause = (cause: unknown): unknown =>
	cause instanceof Error && cause.cause !== undefined ? cause.cause : undefined

const errorCode = (error: DatabaseError): string | undefined =>
	driverRootError(error.cause)?.code ?? causeCode(error.cause) ?? causeCode(nestedCause(error.cause))

/**
 * A machine-readable class for the failure, for the span's `error.type`.
 *
 * `toDatabaseError` flattens everything into a message string, which made a
 * dial timeout indistinguishable from a constraint violation once it reached a
 * trace. The driver's own code is that distinction where there is one; where
 * there is none, `@effect/sql`'s reason tag (`ConnectionError`,
 * `AuthenticationError`, …) says which class the failure belongs to.
 */
export const postgresErrorType = (error: DatabaseError): string | undefined => {
	const code = errorCode(error)
	if (code !== undefined) return code
	if (isConnectionReason(error.cause)) return "ConnectionError"
	const reason = driverReason(error.cause)
	if (reason !== undefined) return reason._tag
	if (error.cause instanceof Error && error.cause.name !== "Error") return error.cause.name
	return undefined
}

/** SQLSTATE for a statement failure, or undefined for connection-class failures. */
export const postgresSqlState = (error: DatabaseError): string | undefined => {
	const code = errorCode(error)
	return code !== undefined && SQLSTATE.test(code) ? code : undefined
}

/**
 * True when the failure is the connection rather than the statement.
 *
 * Worth separating in dashboards: connection failures track the Worker's
 * six-slot outbound budget and say nothing about the query, so mixing them into
 * a single database-error rate hides both signals.
 */
export const isPostgresConnectionError = (error: DatabaseError): boolean => {
	if (isConnectionReason(error.cause)) return true
	const code = errorCode(error)
	return code !== undefined && CONNECTION_ERROR_CODES.has(code)
}
