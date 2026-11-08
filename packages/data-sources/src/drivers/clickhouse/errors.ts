import { String as Str } from "effect"
import type { ClickHouseError, ClickHouseServerError } from "@maple-dev/effect-clickhouse-http"
import {
	DataSourceConnectionError,
	DataSourceLimitError,
	DataSourceQueryError,
	DataSourceTimeoutError,
	DataSourceValidationError,
} from "@maple/domain/data-sources"

export type MappedError =
	| DataSourceConnectionError
	| DataSourceQueryError
	| DataSourceTimeoutError
	| DataSourceLimitError
	| DataSourceValidationError

const MAX_MESSAGE = 1_000
const AUTH_CODES = new Set(["516", "192", "193", "194"])
const TIMEOUT_CODES = new Set(["159", "160", "209", "210"])
const LIMIT_CODES = new Set(["158", "241", "307", "396"])

/** ClickHouse's own text without the `HTTP 500:` prefix, version suffix and stack, bounded. */
export const serverMessage = (error: ClickHouseServerError): string => {
	const text = Str.trim(Str.replace(/^HTTP \d+:\s*/, "")(error.message))
	const trimmed = Str.trim(
		Str.replace(/\s*\(version [^()]*(?:\([^()]*\))?\)\s*$/, "")(Str.split("\n")(text)[0] ?? text),
	)
	return trimmed.length > MAX_MESSAGE ? `${Str.slice(0, MAX_MESSAGE)(trimmed)}...` : trimmed
}

const causeText = (cause: unknown): string => {
	if (typeof cause === "string") return cause
	if (typeof cause !== "object" || cause === null) return ""
	const code = "code" in cause && typeof cause.code === "string" ? cause.code : ""
	const message = "message" in cause && typeof cause.message === "string" ? cause.message : ""
	const inner = "cause" in cause ? causeText(cause.cause) : ""
	return `${code} ${message} ${inner}`
}

/** DNS, refused, TLS or other network trouble, worded without the URL or credentials. */
const transportError = (cause: unknown, host: string): DataSourceConnectionError => {
	const text = causeText(cause)
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|resolve/i.test(text)) {
		return new DataSourceConnectionError({
			reason: "network",
			message: `Could not resolve ${host}. Check the host name.`,
		})
	}
	if (/ECONNREFUSED|refused/i.test(text)) {
		return new DataSourceConnectionError({
			reason: "refused",
			message: `${host} refused the connection. Check the port and that ClickHouse's HTTP interface is open to Maple.`,
		})
	}
	if (/CERT|TLS|SSL|certificate|handshake/i.test(text)) {
		return new DataSourceConnectionError({
			reason: "tls",
			message: `The TLS handshake with ${host} failed. Check the certificate and that the port speaks HTTPS.`,
		})
	}
	return new DataSourceConnectionError({ reason: "network", message: `Could not reach ${host}.` })
}

/** Maps a client failure to a driver error. `hint` is appended to query errors only. */
export const mapClickHouseError = (
	error: ClickHouseError,
	context: {
		readonly host: string
		readonly timeoutMs: number
		readonly hint?: (error: ClickHouseServerError) => string
	},
): MappedError => {
	switch (error._tag) {
		case "@effect-clickhouse-http/ConfigError":
			return new DataSourceValidationError({
				message: "The ClickHouse URL, user or settings are invalid.",
				field: "url",
			})
		case "@effect-clickhouse-http/TransportError":
			return transportError(error.cause, context.host)
		case "@effect-clickhouse-http/RedirectError":
			return new DataSourceConnectionError({
				reason: "config",
				message: `${context.host} answered with a redirect (${error.status}); use the final URL of the HTTP interface.`,
			})
		case "@effect-clickhouse-http/LimitError":
			return new DataSourceLimitError({
				message: `The result is larger than Maple reads (${error.kind} over ${error.limit}). Aggregate, select fewer columns or add a LIMIT.`,
			})
		case "@effect-clickhouse-http/ProtocolError":
			return new DataSourceQueryError({ message: "ClickHouse sent a response Maple could not read." })
		case "@effect-clickhouse-http/ServerError": {
			const message = serverMessage(error)
			const code = error.code
			if (
				(code !== undefined && AUTH_CODES.has(code)) ||
				error.status === 401 ||
				error.status === 403
			) {
				return new DataSourceConnectionError({
					reason: "auth",
					message: `ClickHouse refused the credentials: ${message}`,
				})
			}
			if (code !== undefined && TIMEOUT_CODES.has(code)) {
				return new DataSourceTimeoutError({ message, timeoutMs: context.timeoutMs })
			}
			if (code !== undefined && LIMIT_CODES.has(code)) return new DataSourceLimitError({ message })
			return new DataSourceQueryError({ message: message + (context.hint?.(error) ?? "") })
		}
	}
}
