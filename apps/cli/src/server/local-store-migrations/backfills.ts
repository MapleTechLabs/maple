// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// Backfill SQL and the one custom step that `steps.ts` references. Each projection
// is frozen byte-for-byte to the view body its snapshot installs, so backfilled and live rows agree.
import { Schema } from "effect"
import { applyRawTelemetryRetentionFloor } from "../chdb"
import { decodeRowCounts } from "../chdb-rows"
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
