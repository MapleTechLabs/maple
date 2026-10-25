// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// Backfill SQL and the custom steps that `steps.ts` references. Each projection
// is frozen byte-for-byte to the view body its snapshot installs, so backfilled and live rows agree.
import { Schema } from "effect"
import { applyRawTelemetryRetentionFloor } from "../chdb"
import { decodeJsonEachRow, decodeRowCounts } from "../chdb-rows"
import { localSchemaSnapshot } from "../schema-identity"
import { customStep, LocalMigrationStepError } from "./step-executor"
import { UnsignedDecimal } from "./journal-codecs"

/** v10 -> v11: the SELECT of `product_events_mv` in the v11 snapshot (migration 0021). */
const PRODUCT_EVENTS_PROJECTION_SQL = `OrgId,
  Timestamp,
  'browser' AS Source,
  SessionId,
  Seq,
  VisitorId,
  UserId,
  GroupId,
  Type AS Kind,
  if(Type = 'navigation', '$pageview', Message) AS EventName,
  domain(Url) AS Host,
  path(Url) AS PagePath,
  Url,
  '' AS ServiceName,
  Attributes`

const PRODUCT_EVENTS_COLUMNS =
	"OrgId, Timestamp, Source, SessionId, Seq, VisitorId, UserId, GroupId, Kind, EventName, Host, PagePath, Url, ServiceName, Attributes"

export const PRODUCT_EVENTS_SOURCE_FILTER = "Type IN ('navigation', 'custom')"

export const IDENTITY_LINKS_SOURCE_FILTER = "VisitorId != '' AND UserId != ''"

/** Browser-only clear so a re-run never destroys a row it cannot rebuild. */
export const PRODUCT_EVENTS_BROWSER_BACKFILL = [
	"DELETE FROM product_events WHERE Source = 'browser'",
	`INSERT INTO product_events (${PRODUCT_EVENTS_COLUMNS}) SELECT ${PRODUCT_EVENTS_PROJECTION_SQL} FROM session_events WHERE ${PRODUCT_EVENTS_SOURCE_FILTER}`,
	`INSERT INTO identity_links (OrgId, VisitorId, UserId, FirstSeen) SELECT OrgId, VisitorId, UserId, StartTime AS FirstSeen FROM session_replays WHERE ${IDENTITY_LINKS_SOURCE_FILTER}`,
] as const

const PRODUCT_EVENTS_TRACE_COLUMNS = [
	"OrgId",
	"Timestamp",
	"Source",
	"SessionId",
	"Seq",
	"VisitorId",
	"UserId",
	"GroupId",
	"Kind",
	"EventName",
	"Host",
	"PagePath",
	"Url",
	"ServiceName",
	"Attributes",
	"TraceId",
	"SpanId",
].join(", ")

/** v17 -> v18: migration 0028's trace projection, byte-for-byte. */
const PRODUCT_EVENTS_TRACE_PROJECTION_SQL = `OrgId,
  Timestamp,
  'trace' AS Source,
  SpanAttributes['session.id'] AS SessionId,
  0 AS Seq,
  SpanAttributes['maple.product_event.visitor_id'] AS VisitorId,
  SpanAttributes['maple.product_event.user_id'] AS UserId,
  SpanAttributes['maple.product_event.group_id'] AS GroupId,
  'custom' AS Kind,
  SpanAttributes['maple.product_event.name'] AS EventName,
  domain(SpanAttributes['maple.product_event.url']) AS Host,
  path(SpanAttributes['maple.product_event.url']) AS PagePath,
  SpanAttributes['maple.product_event.url'] AS Url,
  ServiceName,
  mapUpdate(
    CAST(
      mapFilter(
        (k, v) -> NOT startsWith(k, 'maple.product_event.')
          AND (
            NOT has(mapKeys(SpanAttributes), 'maple.product_event.include')
            OR has(
              arrayMap(
                key -> trimBoth(key),
                splitByChar(',', SpanAttributes['maple.product_event.include'])
              ),
              k
            )
          ),
        SpanAttributes
      ),
      'Map(String, String)'
    ),
    mapApply(
      (k, v) -> (substring(k, 26), v),
      mapFilter((k, v) -> startsWith(k, 'maple.product_event.prop.'), SpanAttributes)
    )
  ) AS Attributes,
  TraceId,
  SpanId`

export const PRODUCT_EVENTS_TRACE_FILTER = "SpanAttributes['maple.product_event.name'] != ''"

/** The delete is scoped to the window `traces` still holds (product_events keeps 365 days, traces 30). */
export const PRODUCT_EVENTS_TRACE_BACKFILL = [
	"DELETE FROM product_events WHERE Source = 'trace' AND (SELECT count() FROM traces) > 0 AND Timestamp >= (SELECT min(Timestamp) FROM traces)",
	`INSERT INTO product_events (${PRODUCT_EVENTS_TRACE_COLUMNS}) SELECT ${PRODUCT_EVENTS_TRACE_PROJECTION_SQL} FROM traces WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
] as const

const ERROR_ROLLUP_BACKFILL_SQL = `INSERT INTO error_fingerprints_minutely
SELECT
	OrgId,
	toStartOfMinute(Timestamp) AS Minute,
	FingerprintHash,
	anyLast(ServiceName) AS ServiceName,
	anyLast(ExceptionType) AS ExceptionType,
	anyLast(ExceptionMessage) AS ExceptionMessage,
	anyLast(ErrorLabel) AS ErrorLabel,
	anyLast(TopFrame) AS TopFrame,
	count() AS OccurrenceCount,
	min(Timestamp) AS FirstSeen,
	max(Timestamp) AS LastSeen
FROM error_events
GROUP BY OrgId, Minute, FingerprintHash`

const ErrorRollupProgress = Schema.Struct({ backfilledErrorEvents: UnsignedDecimal })

/** v1 -> v2: the only step whose progress is a backfill total rather than an installed flag. */
export const errorRollupBackfill = customStep({
	progress: ErrorRollupProgress,
	apply: (db, state) => {
		if (state.retentionDays !== undefined) applyRawTelemetryRetentionFloor(db, state.retentionDays)
		db.exec(ERROR_ROLLUP_BACKFILL_SQL)
		const [row] = decodeRowCounts(
			db.query("SELECT toString(sum(OccurrenceCount)) AS rowCount FROM error_fingerprints_minutely"),
		)
		return { backfilledErrorEvents: row?.rowCount ?? "0" }
	},
	verify: (db, _state, progress) => {
		const [row] = decodeRowCounts(db.query("SELECT toString(count()) AS rowCount FROM error_events"))
		if ((row?.rowCount ?? "0") !== progress.backfilledErrorEvents)
			throw new LocalMigrationStepError({
				message: "v1 -> v2 error rollup backfill verification failed",
				moduleId: "local-0001-to-0002-error-rollup",
			})
	},
})

/** v33 -> v34: the sort key `traces` is copied into; `system.tables` spells it so. */
const TRACES_V34_SORTING_KEY = "OrgId, ServiceName, toStartOfFiveMinutes(Timestamp), TraceId"

/** No view reads this name, so the copy into it fires none of the views on `traces`. */
const TRACES_REKEY_STAGING = "traces_v34_rekey"

const decodeTracesDefinition = decodeJsonEachRow(
	Schema.Struct({ sortingKey: Schema.String, definition: Schema.String }),
)

const rekeyFailure = (message: string): never => {
	throw new LocalMigrationStepError({ message, moduleId: "local-0033-to-0034-traces-trace-key" })
}

/** The frozen v34 `traces` DDL under the staging name, keeping the store's TTL (a retention floor may raise it). */
const tracesStagingDdl = (ttl: string): string => {
	const ddl = /CREATE TABLE IF NOT EXISTS traces \([^;]*\nTTL [^;\n]*;/.exec(
		localSchemaSnapshot(34).sql,
	)?.[0]
	if (ddl === undefined) return rekeyFailure("v33 -> v34 found no traces DDL in the v34 snapshot")
	return ddl
		.replace("CREATE TABLE IF NOT EXISTS traces (", `CREATE TABLE ${TRACES_REKEY_STAGING} (`)
		.replace(/\nTTL [^;\n]*;$/, `\nTTL ${ttl}`)
}

const TracesRekeyProgress = Schema.Struct({ rekeyedTraces: UnsignedDecimal })

/**
 * v33 -> v34: a sort key cannot change in place, so `traces` is copied into a view-free
 * staging table with the v34 key and swapped in by EXCHANGE, which fires no view. A
 * re-run that finds the v34 key only drops the leftover staging table.
 */
export const tracesTraceKeyRekey = customStep({
	progress: TracesRekeyProgress,
	apply: (db) => {
		db.exec(`DROP TABLE IF EXISTS ${TRACES_REKEY_STAGING}`)
		const [traces] = decodeTracesDefinition(
			db.query(
				"SELECT sorting_key AS sortingKey, create_table_query AS definition FROM system.tables WHERE database = 'default' AND name = 'traces'",
			),
		)
		if (traces === undefined) return rekeyFailure("v33 -> v34 found no traces table to re-sort")
		if (traces.sortingKey !== TRACES_V34_SORTING_KEY) {
			const ttl = traces.definition.match(/\bTTL\s+(.+?)(?=\bSETTINGS\b|$)/is)?.[1]?.trim()
			if (ttl === undefined) return rekeyFailure("v33 -> v34 cannot read the TTL of traces")
			db.exec(tracesStagingDdl(ttl))
			db.exec(`INSERT INTO ${TRACES_REKEY_STAGING} SELECT * FROM traces`)
			db.exec(`EXCHANGE TABLES traces AND ${TRACES_REKEY_STAGING}`)
			db.exec(`DROP TABLE ${TRACES_REKEY_STAGING}`)
		}
		const [row] = decodeRowCounts(db.query("SELECT toString(count()) AS rowCount FROM traces"))
		return { rekeyedTraces: row?.rowCount ?? "0" }
	},
	verify: (db) => {
		const [row] = decodeRowCounts(
			db.query(
				`SELECT toString(count()) AS rowCount FROM system.tables WHERE database = 'default' AND name = '${TRACES_REKEY_STAGING}'`,
			),
		)
		if ((row?.rowCount ?? "0") !== "0")
			rekeyFailure(`v33 -> v34 left the ${TRACES_REKEY_STAGING} staging table behind`)
	},
})
