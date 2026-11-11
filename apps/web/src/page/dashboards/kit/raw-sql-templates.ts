import { rawSqlDisplayTypeFor, type RawSqlDisplayType } from "@maple/domain/http"

// Default ClickHouse SQL templates per Raw SQL display type: a widget switched to Raw SQL for the
// first time starts on one, so the preview renders immediately.

export { rawSqlDisplayTypeFor as visualizationToDisplayType }

const TIMESERIES_TEMPLATE = `SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
       count() AS logs
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY bucket
ORDER BY bucket`

const TABLE_TEMPLATE = `SELECT ServiceName, count() AS spans
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY ServiceName
ORDER BY spans DESC
LIMIT 20`

const STAT_TEMPLATE = `SELECT count() AS value
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)`

const PIE_TEMPLATE = `SELECT ServiceName AS name, count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY name
ORDER BY value DESC
LIMIT 8`

const FUNNEL_TEMPLATE = `SELECT ServiceName AS name, count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY name
ORDER BY value DESC
LIMIT 8`

const HBAR_TEMPLATE = `SELECT SpanName AS name, count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY name
ORDER BY value DESC
LIMIT 10`

const HISTOGRAM_TEMPLATE = `SELECT Duration / 1000000 AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
LIMIT 5000`

const HEATMAP_TEMPLATE = `SELECT ServiceName AS x,
       toString(toHour(Timestamp)) AS y,
       count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY x, y
ORDER BY x, y`

export const RAW_SQL_TEMPLATES: Record<RawSqlDisplayType, string> = {
	line: TIMESERIES_TEMPLATE,
	area: TIMESERIES_TEMPLATE,
	bar: TIMESERIES_TEMPLATE,
	table: TABLE_TEMPLATE,
	stat: STAT_TEMPLATE,
	pie: PIE_TEMPLATE,
	funnel: FUNNEL_TEMPLATE,
	hbar: HBAR_TEMPLATE,
	histogram: HISTOGRAM_TEMPLATE,
	heatmap: HEATMAP_TEMPLATE,
} satisfies Record<RawSqlDisplayType, string>
