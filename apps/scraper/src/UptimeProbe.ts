import { Option, Schema } from "effect"

/**
 * Why a check failed, the span's `error.type`. `assertion` is a target that answered but
 * broke a rule (a 503, a slow response); every other value is a transport failure.
 */
export type UptimeFailureType =
	| "assertion"
	| "timeout"
	| "dns"
	| "connection_refused"
	| "tls"
	| "ssrf_refused"
	| "transport"

/** One check's result. A probe never fails: every failure is an outcome with `ok: false`. */
export interface ProbeOutcome {
	readonly ok: boolean
	readonly durationMs: number
	readonly statusCode: number | null
	/** One sentence for the monitor page, e.g. `Status 503, expected 2xx`; null when ok. */
	readonly error: string | null
	readonly errorType: UptimeFailureType | null
}

/** The W3C ids a check runs under; HTTP sends them so the target's server span joins the trace. */
export interface CheckTraceContext {
	readonly traceId: string
	readonly spanId: string
}

export const traceparentOf = (context: CheckTraceContext): string =>
	`00-${context.traceId}-${context.spanId}-01`

export const succeeded = (durationMs: number, statusCode: number | null = null): ProbeOutcome => ({
	ok: true,
	durationMs,
	statusCode,
	error: null,
	errorType: null,
})

export const failed = (
	durationMs: number,
	errorType: UptimeFailureType,
	error: string,
	statusCode: number | null = null,
): ProbeOutcome => ({ ok: false, durationMs, statusCode, error, errorType })

/** `10 s`, `2.5 s`: timeouts are whole or half seconds in practice. */
export const formatSeconds = (ms: number): string => `${Number((ms / 1000).toFixed(1))} s`

const ErrorCode = Schema.Struct({ code: Schema.String })
const WithCause = Schema.Struct({ cause: Schema.Unknown })
const decodeCode = Schema.decodeUnknownOption(ErrorCode)
const decodeCause = Schema.decodeUnknownOption(WithCause)

/** The `code` of a system error (`ECONNREFUSED`), looking one `cause` deep for undici's wrapper. */
export const errorCodeOf = (error: unknown): string | null =>
	Option.getOrNull(
		Option.orElse(
			Option.map(decodeCode(error), (value) => value.code),
			() =>
				Option.flatMap(decodeCause(error), (value) =>
					Option.map(decodeCode(value.cause), (inner) => inner.code),
				),
		),
	)

const REFUSED_CODES = new Set(["ECONNREFUSED", "ConnectionRefused"])
const RESET_CODES = new Set(["ECONNRESET", "ConnectionClosed", "EPIPE"])
const UNREACHABLE_CODES = new Set(["EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"])

export const isRefusedCode = (code: string | null): boolean => code !== null && REFUSED_CODES.has(code)

/** Certificate and handshake failures from Node, undici and Bun all name themselves one of these ways. */
export const isTlsCode = (code: string | null): boolean =>
	code !== null &&
	(code.includes("CERT") ||
		code.includes("TLS") ||
		code.includes("SSL") ||
		code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
		code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY")

/** A transport failure as a sentence about `endpoint` (`host:port`). */
export const describeTransportFailure = (
	endpoint: string,
	code: string | null,
	fallback: string,
): { readonly errorType: UptimeFailureType; readonly error: string } => {
	if (isRefusedCode(code))
		return { errorType: "connection_refused", error: `Connection refused by ${endpoint}` }
	if (code !== null && RESET_CODES.has(code))
		return { errorType: "transport", error: `Connection to ${endpoint} was reset` }
	if (code !== null && UNREACHABLE_CODES.has(code))
		return { errorType: "transport", error: `Couldn't reach ${endpoint}: network unreachable` }
	if (isTlsCode(code)) return { errorType: "tls", error: `TLS handshake with ${endpoint} failed (${code})` }
	return { errorType: "transport", error: `Couldn't connect to ${endpoint}: ${fallback}` }
}
