import { Effect, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import type { ListLogsOutput, LogsCountOutput } from "@maple/domain/tinybird"
import { LOGS_BODY_SEARCH_SETTINGS } from "../profiles"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { SearchLogsInput } from "./types"
import { toLogEntry } from "./row-mappers"

const StringRecordFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

/** Attribute keys that usually carry a log's real cause when the body is generic. */
export const isKeyLogAttribute = (key: string): boolean =>
	key === "log.error" ||
	key === "error" ||
	Str.endsWith(".error")(key) ||
	Str.startsWith("error.")(key) ||
	Str.startsWith("exception.")(key)

const logAttributes = (raw: string | undefined): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw ?? "{}").pipe(
		Effect.map((parsed) => Rec.fromEntries(Arr.filter(Rec.toEntries(parsed), ([, v]) => v !== ""))),
		Effect.orElseSucceed(() => ({})),
	)

export const searchLogs = Effect.fn("Observability.searchLogs")(function* (input: SearchLogsInput) {
	const executor = yield* WarehouseExecutor
	const limit = input.limit ?? 30
	const offset = input.offset ?? 0

	const optionalParams: Record<string, unknown> = {
		...(input.service && { service: input.service }),
		...(input.severity && { severity: input.severity }),
		...(input.search && { search: input.search }),
		...(input.traceId && { trace_id: input.traceId }),
		...(input.spanId && { span_id: input.spanId }),
	} satisfies Record<string, unknown>

	const params = {
		start_time: input.timeRange.startTime,
		end_time: input.timeRange.endTime,
		limit,
		offset,
		...optionalParams,
	}

	// A Body search forces both queries to read the wide Body column for the
	// ILIKE filter — cap the read block size so peak memory stays granule-,
	// not block-, bound (see WarehouseQuerySettings.maxBlockSize).
	const searchSettings = input.search ? LOGS_BODY_SEARCH_SETTINGS : undefined

	const [logsResult, countResult] = yield* Effect.all(
		[
			executor.query<ListLogsOutput>("list_logs", params, {
				profile: "list",
				settings: searchSettings,
			}),
			// The exact count scans every match while the page stops at `limit`, so on a body search
			// it was the half that timed out. Losing it must not lose the page.
			executor
				.query<LogsCountOutput>(
					"logs_count",
					{
						start_time: input.timeRange.startTime,
						end_time: input.timeRange.endTime,
						...optionalParams,
					},
					{ profile: "discovery", settings: searchSettings },
				)
				.pipe(
					Effect.map((result) => Number(result.data[0]?.total ?? 0)),
					Effect.catchTags({
						"@maple/http/errors/WarehouseQuotaExceededError": (error) =>
							Effect.as(
								Effect.annotateCurrentSpan("maple.logs.count_error", error._tag),
								undefined,
							),
						// The executor's own client timeout; a real SQL error fails the page read too.
						"@maple/http/errors/WarehouseQueryError": (error) =>
							Effect.as(
								Effect.annotateCurrentSpan("maple.logs.count_error", error._tag),
								undefined,
							),
					}),
				),
		],
		{ concurrency: "unbounded" },
	)

	const logs = yield* Effect.forEach(logsResult.data, (row) =>
		Effect.map(logAttributes(row.logAttributes), (attributes) => ({
			...toLogEntry(row),
			keyAttributes: Rec.fromEntries(
				Arr.filter(Rec.toEntries(attributes), ([k]) => isKeyLogAttribute(k)),
			),
			...(input.includeAttributes === true && { attributes }),
		})),
	)
	// Without the count, what this page proves exists.
	const total = countResult ?? (logs.length === 0 ? 0 : offset + logs.length)

	return {
		timeRange: input.timeRange,
		total,
		...(countResult === undefined ? { totalIsLowerBound: true } : undefined),
		logs,
		pagination: { offset, limit, hasMore: logs.length === limit },
	}
})
