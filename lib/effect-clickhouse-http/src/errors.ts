import { Schema, type Types } from "effect"

const metadata = { status: Schema.Number, queryId: Schema.String }

export class ClickHouseConfigError extends Schema.TaggedError<ClickHouseConfigError>()(
	"@effect-clickhouse-http/ConfigError",
	{ message: Schema.String },
) {}

/** The request never produced a usable HTTP response: DNS, TLS, reset, abort. */
export class ClickHouseTransportError extends Schema.TaggedError<ClickHouseTransportError>()(
	"@effect-clickhouse-http/TransportError",
	{ message: Schema.String, queryId: Schema.String, cause: Schema.Defect() },
) {}

export class ClickHouseServerError extends Schema.TaggedError<ClickHouseServerError>()(
	"@effect-clickhouse-http/ServerError",
	{
		...metadata,
		message: Schema.String,
		code: Schema.optionalKey(Schema.String),
		type: Schema.optionalKey(Schema.String),
	},
) {}

export class ClickHouseProtocolError extends Schema.TaggedError<ClickHouseProtocolError>()(
	"@effect-clickhouse-http/ProtocolError",
	{ ...metadata, message: Schema.String },
) {}

export class ClickHouseLimitError extends Schema.TaggedError<ClickHouseLimitError>()(
	"@effect-clickhouse-http/LimitError",
	{
		...metadata,
		message: Schema.String,
		kind: Schema.Literals(["bytes", "rows", "rowBytes"]),
		limit: Schema.Number,
	},
) {}

export class ClickHouseRedirectError extends Schema.TaggedError<ClickHouseRedirectError>()(
	"@effect-clickhouse-http/RedirectError",
	{ ...metadata, message: Schema.String, location: Schema.optionalKey(Schema.String) },
) {}

export type ClickHouseError =
	| ClickHouseConfigError
	| ClickHouseTransportError
	| ClickHouseServerError
	| ClickHouseProtocolError
	| ClickHouseLimitError
	| ClickHouseRedirectError

/** Bounded input only. Preserve server identity, including nested cluster exceptions. */
export const serverError = (text: string, status: number, queryId: string, headerCode?: string) => {
	const code = text.match(/\b(?:Code|Error):\s*(\d+)/)?.[1] ?? headerCode
	const lastException = text.lastIndexOf("Exception:")
	const detail = lastException >= 0 ? text.slice(lastException + "Exception:".length).trim() : text.trim()
	const type = detail.match(/\(([A-Z][A-Z0-9_]{2,})\)/)?.[1]
	const identity: Types.Mutable<Pick<ClickHouseServerError, "code" | "type">> = {}
	if (code !== undefined) identity.code = code
	if (type !== undefined) identity.type = type
	return new ClickHouseServerError({
		status,
		queryId,
		message: `HTTP ${status}: ${detail || "ClickHouse request failed"}`,
		...identity,
	})
}
