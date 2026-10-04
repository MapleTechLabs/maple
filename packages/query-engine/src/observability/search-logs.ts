import { Effect, Schema } from "effect"
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
	key.endsWith(".error") ||
	key.startsWith("error.") ||
	key.startsWith("exception.")

const keyLogAttributes = (raw: string | undefined): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw ?? "{}").pipe(
		Effect.map((parsed) =>
			Object.fromEntries(Object.entries(parsed).filter(([k, v]) => v !== "" && isKeyLogAttribute(k))),
		),
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
			executor.query<LogsCountOutput>(
				"logs_count",
				{
					start_time: input.timeRange.startTime,
					end_time: input.timeRange.endTime,
					...optionalParams,
				},
				{ profile: "discovery", settings: searchSettings },
			),
		],
		{ concurrency: "unbounded" },
	)

	const logs = yield* Effect.forEach(logsResult.data, (row) =>
		Effect.map(keyLogAttributes(row.logAttributes), (keyAttributes) => ({
			...toLogEntry(row),
			keyAttributes,
		})),
	)
	const total = Number(countResult.data[0]?.total ?? 0)

	return {
		timeRange: input.timeRange,
		total,
		logs,
		pagination: { offset, limit, hasMore: logs.length === limit },
	}
})
