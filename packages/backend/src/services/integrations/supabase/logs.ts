/**
 * Supabase project logs over the Management API's logs endpoint
 * (`/v1/projects/{ref}/analytics/endpoints/logs`), mapped to OTLP/HTTP JSON log records.
 * The endpoint takes one SELECT over the unified `logs` table; every value Maple puts in the SQL
 * is a timestamp it formats itself, never user input.
 */
import { SOURCE_ID_ATTRIBUTE } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { SupabaseProjectRef } from "@maple/domain/primitives"
import { timestampMs } from "@maple/backend/platform/time"
import { send, SupabaseApiError } from "./api"
import { SUPABASE_SERVICE_NAME } from "./scrape-targets"

/** Rows asked for per query; a full page means the window has more. */
export const LOGS_PAGE_SIZE = 1000
/** Logs land late; stay this far behind now. */
const LOGS_LAG_MS = 60_000
/** History read when a project's logs are turned on. */
export const LOGS_INITIAL_LOOKBACK_MS = 5 * 60_000
/** One query covers at most this much; the endpoint allows 24h. */
const LOGS_MAX_WINDOW_MS = 60 * 60_000
const SCOPE_NAME = "@maple/supabase-logs"

/** The endpoint answered 200 with `{ "error": ... }`: the SQL was refused (e.g. unknown field). */
export class SupabaseLogsQueryError extends Schema.TaggedError<SupabaseLogsQueryError>()(
	"@maple/supabase/SupabaseLogsQueryError",
	{ message: Schema.String },
) {}

/** Next window for a project, or null when it is caught up. `startMs` is inclusive, `endMs` exclusive. */
export const nextLogsWindow = (watermarkAt: number | null, now: number) => {
	const horizonMs = Math.floor((now - LOGS_LAG_MS) / 1000) * 1000
	const startMs = watermarkAt ?? horizonMs - LOGS_INITIAL_LOOKBACK_MS
	const endMs = Math.min(horizonMs, startMs + LOGS_MAX_WINDOW_MS)
	return startMs < endMs ? { startMs, endMs } : null
}

/** `2026-10-21 17:48:12.059000`, the `timestamp` column's own UTC format. Built from a Date only. */
const sqlTimestamp = (ms: number) => {
	const iso = new Date(ms).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000`
}

export const logsQuerySql = (window: { readonly startMs: number; readonly endMs: number }) =>
	`select id, timestamp, source, event_message, log_attributes from logs where timestamp >= '${sqlTimestamp(window.startMs)}' and timestamp < '${sqlTimestamp(window.endMs)}' order by timestamp asc, id asc limit ${LOGS_PAGE_SIZE}`

const MINUTE_MS = 60_000

/** The endpoint rounds its range to the minute, so widen it outward; the SQL bounds are exact. */
export const logsQueryUrl = (
	apiBaseUrl: string,
	projectRef: SupabaseProjectRef,
	window: { readonly startMs: number; readonly endMs: number },
) => {
	const params = new URLSearchParams({
		sql: logsQuerySql(window),
		iso_timestamp_start: new Date(Math.floor(window.startMs / MINUTE_MS) * MINUTE_MS).toISOString(),
		iso_timestamp_end: new Date(Math.ceil(window.endMs / MINUTE_MS) * MINUTE_MS).toISOString(),
	})
	return `${apiBaseUrl}/v1/projects/${projectRef}/analytics/endpoints/logs?${params.toString()}`
}

const LogsResponse = Schema.Union([
	Schema.Struct({ result: Schema.Array(Schema.Unknown) }),
	Schema.Struct({ error: Schema.Unknown }),
])
const decodeLogsResponse = Schema.decodeUnknownOption(Schema.fromJsonString(LogsResponse))

const errorText = (error: unknown) =>
	(typeof error === "string" ? error : (JSON.stringify(error) ?? "unknown error")).slice(0, 300)

/** One page of raw rows; a refused query fails with {@link SupabaseLogsQueryError}. */
export const queryLogs = Effect.fn("SupabaseApi.queryLogs")(function* (
	httpClient: HttpClient.HttpClient,
	apiBaseUrl: string,
	accessToken: string,
	projectRef: SupabaseProjectRef,
	window: { readonly startMs: number; readonly endMs: number },
) {
	const text = yield* send(
		httpClient,
		HttpClientRequest.get(logsQueryUrl(apiBaseUrl, projectRef, window)).pipe(
			HttpClientRequest.bearerToken(accessToken),
			HttpClientRequest.acceptJson,
		),
		"reading project logs",
	)
	const body = decodeLogsResponse(text)
	if (Option.isNone(body)) {
		return yield* new SupabaseApiError({
			message: "Supabase returned an unexpected body while reading project logs",
			kind: "upstream",
		})
	}
	if ("error" in body.value) {
		return yield* new SupabaseLogsQueryError({
			message: `Supabase refused the logs query: ${errorText(body.value.error)}`,
		})
	}
	yield* Effect.annotateCurrentSpan("maple.supabase.logs.rows", body.value.result.length)
	return body.value.result
})

const LogRowSchema = Schema.Struct({
	id: Schema.String,
	timestamp: Schema.String,
	source: Schema.String,
	event_message: Schema.optionalKey(Schema.NullOr(Schema.String)),
	log_attributes: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})
type LogRowFields = typeof LogRowSchema.Type
const decodeLogRow = Schema.decodeUnknownOption(LogRowSchema)

/** A decoded row with its time parsed: `ms` for watermarks, `unixNano` (a string) for OTLP. */
export interface SupabaseLogRow extends LogRowFields {
	readonly ms: number
	readonly unixNano: string
}

/** `2026-10-21T17:48:12.059679`, UTC with no zone suffix; a `Z` or `+00:00` suffix is accepted. */
const ROW_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:?00)?$/

export const parseRowTimestamp = (value: string) => {
	const match = ROW_TIMESTAMP.exec(value)
	if (match === null) return undefined
	const secondsMs = timestampMs(`${match[1]}T${match[2]}Z`)
	if (!Number.isFinite(secondsMs) || secondsMs <= 0) return undefined
	const fraction = (match[3] ?? "").padEnd(9, "0")
	return {
		ms: secondsMs + Number(fraction.slice(0, 3)),
		unixNano: `${secondsMs / 1000}${fraction}`,
	}
}

/** Rows that decode and carry a parseable time; the rest are dropped (and counted by the caller). */
export const decodeLogRows = (raw: ReadonlyArray<unknown>): ReadonlyArray<SupabaseLogRow> =>
	raw.flatMap((item) =>
		Option.match(decodeLogRow(item), {
			onNone: () => [],
			onSome: (row) => {
				const time = parseRowTimestamp(row.timestamp)
				return time === undefined ? [] : [{ ...row, ...time }]
			},
		}),
	)

const SEVERITY = {
	DEBUG: { severityNumber: 5, severityText: "DEBUG" },
	INFO: { severityNumber: 9, severityText: "INFO" },
	WARN: { severityNumber: 13, severityText: "WARN" },
	ERROR: { severityNumber: 17, severityText: "ERROR" },
	FATAL: { severityNumber: 21, severityText: "FATAL" },
} as const
type Severity = (typeof SEVERITY)[keyof typeof SEVERITY]

/** Postgres `error_severity` (DEBUG1..5, LOG, NOTICE, WARNING...) or a service's `level` (info, warn...). */
const severityOfLevel = (level: string): Severity | undefined => {
	const value = level.trim().toUpperCase()
	if (value.startsWith("DEBUG") || value === "TRACE") return SEVERITY.DEBUG
	if (value === "LOG" || value === "INFO" || value === "NOTICE") return SEVERITY.INFO
	if (value === "WARN" || value === "WARNING") return SEVERITY.WARN
	if (value === "ERROR" || value === "ERR") return SEVERITY.ERROR
	if (value === "FATAL" || value === "PANIC" || value === "CRITICAL") return SEVERITY.FATAL
	return undefined
}

const severityOfStatus = (status: string | undefined): Severity | undefined => {
	const code = status === undefined ? Number.NaN : Number(status)
	if (code >= 500 && code < 600) return SEVERITY.ERROR
	if (code >= 400 && code < 500) return SEVERITY.WARN
	return undefined
}

const attributeText = (value: unknown) =>
	typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))

/** Severity hint order: postgres `parsed.error_severity`, then `level`, then an HTTP status, else INFO. */
export const severityOf = (attributes: Readonly<Record<string, string>>): Severity =>
	severityOfLevel(attributes["parsed.error_severity"] ?? "") ??
	severityOfLevel(attributes.level ?? "") ??
	severityOfStatus(attributes["response.status_code"] ?? attributes["res.statusCode"]) ??
	SEVERITY.INFO

type OtlpKeyValue = { readonly key: string; readonly value: { readonly stringValue: string } }

const keyValues = (attributes: Readonly<Record<string, string | undefined>>): Array<OtlpKeyValue> =>
	Object.entries(attributes).flatMap(([key, value]) =>
		value === undefined ? [] : [{ key, value: { stringValue: value } }],
	)

export interface SupabaseLogsResource {
	readonly projectRef: string
	readonly projectName: string
	readonly region: string
	readonly organizationSlug: string
	/** The connection's `src_` id, stamped as `maple_source_id`. */
	readonly sourceId: string | undefined
}

export const logRecordOf = (row: SupabaseLogRow) => {
	const attributes = Object.fromEntries(
		Object.entries(row.log_attributes ?? {}).map(([key, value]) => [key, attributeText(value)]),
	)
	return {
		timeUnixNano: row.unixNano,
		...severityOf(attributes),
		// auth_logs' message is a JSON string; it stays the body and its `msg` is already an attribute.
		body: { stringValue: row.event_message ?? "" },
		attributes: keyValues({
			...attributes,
			"supabase.log.source": row.source,
			"log.record.uid": row.id,
		}),
	}
}

export const logsToOtlp = (resource: SupabaseLogsResource, rows: ReadonlyArray<SupabaseLogRow>) => ({
	resourceLogs: [
		{
			resource: {
				attributes: keyValues({
					"service.name": SUPABASE_SERVICE_NAME,
					"supabase.project.ref": resource.projectRef,
					"supabase.project.name": resource.projectName,
					"supabase.project.region": resource.region,
					"supabase.organization.slug": resource.organizationSlug,
					[SOURCE_ID_ATTRIBUTE]: resource.sourceId,
				}),
			},
			scopeLogs: [{ scope: { name: SCOPE_NAME }, logRecords: rows.map(logRecordOf) }],
		},
	],
})

/**
 * Where a project's watermark moves after a page was sent. A short page finishes the window; a
 * full one stops at its last row's millisecond and remembers every id read in it, so the next
 * query (which re-reads that millisecond) drops them. A full page that made no progress (over a
 * page of rows in one millisecond) steps past it.
 */
export const advanceWatermark = (
	window: { readonly startMs: number; readonly endMs: number },
	rawCount: number,
	rows: ReadonlyArray<SupabaseLogRow>,
	freshCount: number,
): { readonly watermarkAt: number; readonly boundaryIds: ReadonlyArray<string> } => {
	const last = rows.at(-1)
	if (rawCount < LOGS_PAGE_SIZE) return { watermarkAt: window.endMs, boundaryIds: [] }
	if (last === undefined || (last.ms <= window.startMs && freshCount === 0)) {
		return { watermarkAt: window.startMs + 1, boundaryIds: [] }
	}
	return {
		watermarkAt: last.ms,
		boundaryIds: rows.filter((row) => row.ms === last.ms).map((row) => row.id),
	}
}

/**
 * Where the watermark sits once a page's rows through `lastSent` (in page order) were accepted: its
 * millisecond, remembering every id read up to it there, the same boundary {@link advanceWatermark} keeps.
 */
export const acceptedWatermark = (
	rows: ReadonlyArray<SupabaseLogRow>,
	lastSent: SupabaseLogRow,
): { readonly watermarkAt: number; readonly boundaryIds: ReadonlyArray<string> } => ({
	watermarkAt: lastSent.ms,
	boundaryIds: rows
		.slice(0, rows.indexOf(lastSent) + 1)
		.filter((row) => row.ms === lastSent.ms)
		.map((row) => row.id),
})
