import { WarehouseQueryError, WarehouseQuotaExceededError } from "@maple/domain/http"
import { detectQuotaSetting } from "../profiles"

export type WarehouseSqlError = WarehouseQueryError | WarehouseQuotaExceededError

type ClickHouseErrorDetails = {
	readonly message: string
	readonly code?: string
	readonly type?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const unknownToMessage = (error: unknown, fallback = "ClickHouse query failed"): string => {
	if (typeof error === "string") return error
	if (error instanceof Error) return error.message
	if (isRecord(error) && typeof error.message === "string") return error.message
	return fallback
}

const getClickHouseErrorDetails = (error: unknown): ClickHouseErrorDetails => {
	const message = unknownToMessage(error)
	if (!isRecord(error)) return { message }
	const code =
		typeof error.code === "string"
			? error.code
			: typeof error.code === "number"
				? String(error.code)
				: undefined
	const type = typeof error.type === "string" ? error.type : undefined
	return { message, code, type }
}

const authClickHouseTypes = new Set([
	"AUTHENTICATION_FAILED",
	"ACCESS_DENIED",
	"USER_DOESNT_EXIST",
	"REQUIRED_PASSWORD",
])

const configClickHouseTypes = new Set([
	"UNKNOWN_DATABASE",
	"UNKNOWN_TABLE",
	"TABLE_IS_DROPPED",
	"UNKNOWN_SETTING",
])

const transientClickHouseTypes = new Set([
	"NETWORK_ERROR",
	"SOCKET_TIMEOUT",
	"TOO_MANY_SIMULTANEOUS_QUERIES",
	"SERVER_OVERLOADED",
	"CANNOT_SCHEDULE_TASK",
	"KEEPER_EXCEPTION",
	"ALL_CONNECTION_TRIES_FAILED",
])

// CH error types raised when a column or function reference doesn't exist in
// the cluster's schema. For BYO-ClickHouse customers this is almost always
// schema drift between Maple's expected schema and what the cluster has —
// resolved by running schema apply, not by retrying. Surfacing it as a
// distinct category lets the MCP layer return an actionable message.
const schemaDriftClickHouseTypes = new Set([
	"UNKNOWN_IDENTIFIER",
	"NO_SUCH_COLUMN_IN_TABLE",
	"THERE_IS_NO_COLUMN",
	"NOT_FOUND_COLUMN_IN_BLOCK",
])

export const cleanErrorMessage = (raw: string): string => {
	let cleaned = raw
	const htmlIndex = cleaned.search(/<\s*(html|head|body|center|h1|hr|title)\b/i)
	if (htmlIndex >= 0) cleaned = cleaned.slice(0, htmlIndex)
	cleaned = cleaned
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	if (cleaned.endsWith(":")) cleaned = cleaned.slice(0, -1).trim()
	return cleaned || raw.slice(0, 200)
}

const extractUpstreamStatus = (message: string): number | undefined => {
	const match = message.match(/(?:status|HTTP status|response status code)[:\s]+(\d{3})/i)
	if (match) return Number(match[1])
	const titleMatch = message.match(/\b(\d{3})\s+(?:error|service temporarily unavailable)\b/i)
	if (titleMatch) return Number(titleMatch[1])
	return undefined
}

export const toWarehouseQueryError = (pipe: string, error: unknown) =>
	new WarehouseQueryError({
		message: cleanErrorMessage(unknownToMessage(error, "Warehouse query failed")),
		pipe,
	})

export const mapWarehouseError = (pipe: string, error: unknown): WarehouseSqlError => {
	const details = getClickHouseErrorDetails(error)
	const rawMessage = details.message
	const message = cleanErrorMessage(rawMessage)
	const setting = detectQuotaSetting(rawMessage, details.code, details.type)
	const clickhouseFields = {
		clickhouseCode: details.code,
		clickhouseType: details.type,
	}
	if (setting) {
		return new WarehouseQuotaExceededError({ pipe, message, setting, ...clickhouseFields })
	}
	const upstreamStatus = extractUpstreamStatus(rawMessage)
	const type = details.type
	const isAuthFailure =
		upstreamStatus === 401 ||
		upstreamStatus === 403 ||
		(type !== undefined && authClickHouseTypes.has(type)) ||
		/authentication failed|access denied|not enough privileges|password is incorrect/i.test(rawMessage)
	if (isAuthFailure) {
		return new WarehouseQueryError({
			pipe,
			message,
			category: "auth",
			upstreamStatus,
			...clickhouseFields,
		})
	}
	const isTransientFailure =
		(upstreamStatus !== undefined &&
			(upstreamStatus === 408 ||
				upstreamStatus === 429 ||
				(upstreamStatus >= 500 && upstreamStatus < 600))) ||
		(type !== undefined && transientClickHouseTypes.has(type)) ||
		/^Timeout error\.?$/i.test(rawMessage) ||
		/The user aborted a request|Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|certificate/i.test(
			rawMessage,
		)
	if (isTransientFailure) {
		return new WarehouseQueryError({
			pipe,
			message,
			category: "upstream",
			upstreamStatus,
			...clickhouseFields,
		})
	}
	const isConfigFailure =
		(upstreamStatus !== undefined && upstreamStatus === 404) ||
		(type !== undefined && configClickHouseTypes.has(type)) ||
		/Invalid URL|unknown database|unknown table|table .* does not exist|database .* does not exist/i.test(
			rawMessage,
		)
	if (isConfigFailure) {
		return new WarehouseQueryError({
			pipe,
			message,
			category: "config",
			upstreamStatus,
			...clickhouseFields,
		})
	}
	const isClientFailure =
		error instanceof SyntaxError ||
		/Cannot decode .* as JSON|Unexpected token .* JSON|Stream has been already consumed|Failed to parse ClickHouse response/i.test(
			rawMessage,
		)
	if (isClientFailure) {
		return new WarehouseQueryError({
			pipe,
			message,
			category: "client",
			upstreamStatus,
			...clickhouseFields,
		})
	}
	const isSchemaDrift =
		(type !== undefined && schemaDriftClickHouseTypes.has(type)) ||
		/Unknown (?:expression or function )?identifier|Missing columns|There is no column|No such column/i.test(
			rawMessage,
		)
	if (isSchemaDrift) {
		return new WarehouseQueryError({
			pipe,
			message,
			category: "schema_drift",
			upstreamStatus,
			...clickhouseFields,
		})
	}
	return new WarehouseQueryError({
		pipe,
		message,
		category: "query",
		upstreamStatus,
		...clickhouseFields,
	})
}
