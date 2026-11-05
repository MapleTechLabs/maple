import { Option, Schema, type Types, String as Str } from "effect"

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
	const code = Str.match(/\b(?:Code|Error):\s*(\d+)/)(text).pipe(
		Option.flatMapNullishOr((found) => found[1]),
		Option.orElse(() => Option.fromNullishOr(headerCode)),
	)
	const detail = Option.match(Str.lastIndexOf("Exception:")(text), {
		onNone: () => Str.trim(text),
		onSome: (at) => Str.trim(Str.slice(at + "Exception:".length)(text)),
	})
	const type = Str.match(/\(([A-Z][A-Z0-9_]{2,})\)/)(detail).pipe(
		Option.flatMapNullishOr((found) => found[1]),
	)
	const identity: Types.Mutable<Pick<ClickHouseServerError, "code" | "type">> = {}
	if (Option.isSome(code)) identity.code = code.value
	if (Option.isSome(type)) identity.type = type.value
	return new ClickHouseServerError({
		status,
		queryId,
		message: `HTTP ${status}: ${detail || "ClickHouse request failed"}`,
		...identity,
	})
}
