// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
/**
 * The BigQuery calls the GCP cost pull makes, as the connector's reader account: the export
 * table's schema, then one aggregating query whose result pages are read in turn. The query runs
 * in the connector's host project, which BigQuery bills for the bytes it scans.
 */
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import type { CostPullWindow } from "../../CostProvider"
import { asReader, type GcpReader, google } from "../../../integrations/gcp/api"

const BIGQUERY_URL = "https://bigquery.googleapis.com"
/** Rows per result page. A grouped cost row is a few hundred bytes of JSON. */
const PAGE_ROWS = 10_000
/**
 * How long BigQuery holds one call for the job before answering `jobComplete: false`, well inside
 * `CALL_TIMEOUT`, so a long job is waited for over several calls instead of timing the client out.
 */
const WAIT_MS = 10_000
const CALL_TIMEOUT = "30 seconds"
/**
 * Partitions after a window that may still hold its days: corrections land until the month's
 * invoice closes early in the next one. Bounding the scan keeps an old backfill step from reading
 * every partition since.
 */
const CORRECTION_DAYS = 45
/**
 * The most one query may scan, billed to the customer's host project: past it BigQuery refuses the
 * job instead of running it. 100 GB is about $0.60 at on-demand prices.
 */
export const MAX_BYTES_BILLED = 100 * 1024 ** 3
/** Resources kept by name per window; the rest of the spend stays, under no resource. */
export const TOP_RESOURCES = 500

// `project.dataset.gcp_billing_export[_resource]_v1_<billing account>`. Project ids are 6 to 30
// lowercase letters, digits and hyphens; dataset ids letters, digits and underscores. The ref is
// inlined into the query, so nothing outside these sets gets through.
const EXPORT_TABLE =
	/^([a-z][a-z0-9-]{4,28}[a-z0-9])[.:]([A-Za-z0-9_]{1,1024})\.(gcp_billing_export(_resource)?_v1_([0-9A-F]{6})_([0-9A-F]{6})_([0-9A-F]{6}))$/u

export interface GcpExportTable {
	/** `project.dataset.table`. */
	readonly ref: string
	readonly projectId: string
	readonly datasetId: string
	readonly tableId: string
	/** The detailed (resource-level) export, which names each resource. */
	readonly detailed: boolean
	/** `01ABCD-234567-89ABCD`. */
	readonly billingAccountId: string
}

/** A pasted export table id, or None when it is not a Cloud Billing export table. */
export const parseExportTable = (input: string): Option.Option<GcpExportTable> => {
	const match = EXPORT_TABLE.exec(Str.trim(input))
	if (match === null) return Option.none()
	const [, projectId = "", datasetId = "", tableId = "", resource, a = "", b = "", c = ""] = match
	return Option.some({
		ref: `${projectId}.${datasetId}.${tableId}`,
		projectId,
		datasetId,
		tableId,
		detailed: resource !== undefined,
		billingAccountId: `${a}-${b}-${c}`,
	})
}

const TableField = Schema.Struct({ name: Schema.String })

const TableInfo = Schema.Struct({
	schema: Schema.optionalKey(Schema.Struct({ fields: Schema.optionalKey(Schema.Array(TableField)) })),
	timePartitioning: Schema.optionalKey(
		Schema.Struct({ type: Schema.optionalKey(Schema.String), field: Schema.optionalKey(Schema.String) }),
	),
})

/** What the query needs to know of the table: which optional columns it has and how it is partitioned. `_PARTITIONTIME` for ingestion-time partitioning. */
export interface GcpExportLayout {
	readonly hasResource: boolean
	readonly hasListCost: boolean
	/** The partition column to bound the scan by, if the table is partitioned. */
	readonly partition: Option.Option<string>
}

const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,299}$/u

export const getExportLayout = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	table: GcpExportTable,
) =>
	google(httpClient, "BigQuery", BIGQUERY_URL, asReader(reader))
		.json(TableInfo, {
			path: `/bigquery/v2/projects/${table.projectId}/datasets/${table.datasetId}/tables/${table.tableId}`,
			query: { selectedFields: "schema,timePartitioning" },
			operation: "reading the billing export table",
		})
		.pipe(
			Effect.map((info): GcpExportLayout => {
				const names = new Set(Arr.map(info.schema?.fields ?? [], (field) => field.name))
				const partitioning = info.timePartitioning
				return {
					hasResource: names.has("resource"),
					hasListCost: names.has("cost_at_list"),
					partition:
						partitioning === undefined
							? Option.none()
							: partitioning.field === undefined
								? Option.some("_PARTITIONTIME")
								: Option.filter(Option.some(partitioning.field), (field) =>
										COLUMN_NAME.test(field),
									),
				}
			}),
		)

/**
 * The window's spend grouped by day, project, service, SKU, region, resource, cost type, currency
 * and unit, with the credits of each group summed apart. Only the `TOP_RESOURCES` costliest
 * resources keep their name. The table is read once: the ranking runs over the grouped rows.
 * Partitions are read from a day before the window, since a usage day is exported on or after
 * itself, to `CORRECTION_DAYS` after it.
 */
export const costQuery = (table: GcpExportTable, layout: GcpExportLayout): string => {
	const resource = layout.hasResource ? "IFNULL(resource.global_name, IFNULL(resource.name, ''))" : "''"
	const listCost = layout.hasListCost ? "IFNULL(cost_at_list, cost)" : "cost"
	const partition = Option.match(layout.partition, {
		onNone: () => "",
		onSome: (column) => {
			const name = column === "_PARTITIONTIME" ? column : `\`${column}\``
			return `AND ${name} >= TIMESTAMP(DATE_SUB(@start_day, INTERVAL 1 DAY))
    AND ${name} < TIMESTAMP(DATE_ADD(@end_day, INTERVAL ${CORRECTION_DAYS} DAY))`
		},
	})
	return `WITH grouped AS (
  SELECT
    FORMAT_DATE('%F', DATE(usage_start_time)) AS day,
    IFNULL(project.id, '') AS project,
    IFNULL(service.description, '') AS service,
    IFNULL(sku.description, '') AS sku,
    IFNULL(location.region, IFNULL(location.location, '')) AS region,
    ${resource} AS resource,
    IFNULL(cost_type, 'regular') AS cost_type,
    currency,
    IFNULL(usage.pricing_unit, '') AS unit,
    SUM(IFNULL(cost, 0)) AS cost,
    SUM(IFNULL(${listCost}, 0)) AS list_cost,
    SUM(IFNULL((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit), 0)) AS credits,
    SUM(IFNULL(usage.amount_in_pricing_units, 0)) AS quantity
  FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
  WHERE usage_start_time >= TIMESTAMP(@start_day)
    AND usage_start_time < TIMESTAMP(DATE_ADD(@end_day, INTERVAL 1 DAY))
    ${partition}
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
),
ranked AS (
  -- Unnamed charges rank last, so they never take a named resource's place.
  SELECT *, DENSE_RANK() OVER (ORDER BY resource = '', resource_cost DESC, resource) AS resource_rank
  FROM (SELECT *, SUM(ABS(cost)) OVER (PARTITION BY resource) AS resource_cost FROM grouped)
)
SELECT
  day, project, service, sku, region,
  IF(resource != '' AND resource_rank <= ${TOP_RESOURCES}, resource, '') AS resource,
  cost_type, currency, unit,
  CAST(SUM(cost) AS STRING) AS cost,
  CAST(SUM(list_cost) AS STRING) AS list_cost,
  CAST(SUM(credits) AS STRING) AS credits,
  CAST(SUM(quantity) AS STRING) AS quantity
FROM ranked
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`
}

/** One row of `costQuery`, every cell as BigQuery answers it: a string, '' for null. */
export interface GcpCostLine {
	readonly day: string
	readonly project: string
	readonly service: string
	readonly sku: string
	readonly region: string
	readonly resource: string
	readonly costType: string
	readonly currency: string
	readonly unit: string
	readonly cost: string
	readonly listCost: string
	readonly credits: string
	readonly quantity: string
}

const Cell = Schema.Struct({ v: Schema.NullOr(Schema.String) })
const ResultRow = Schema.Struct({ f: Schema.Array(Cell) })

const QueryPage = Schema.Struct({
	jobComplete: Schema.optionalKey(Schema.Boolean),
	jobReference: Schema.optionalKey(
		Schema.Struct({ jobId: Schema.String, location: Schema.optionalKey(Schema.String) }),
	),
	rows: Schema.optionalKey(Schema.Array(ResultRow)),
	pageToken: Schema.optionalKey(Schema.String),
})
export type GcpQueryPage = typeof QueryPage.Type

/** One result row as named cells, in the order `costQuery` selects them. */
export const lineOf = (row: typeof ResultRow.Type): GcpCostLine => {
	const cell = (index: number) => row.f[index]?.v ?? ""
	return {
		day: cell(0),
		project: cell(1),
		service: cell(2),
		sku: cell(3),
		region: cell(4),
		resource: cell(5),
		costType: cell(6),
		currency: cell(7),
		unit: cell(8),
		cost: cell(9),
		listCost: cell(10),
		credits: cell(11),
		quantity: cell(12),
	}
}

/** Starts the cost query in `jobProject`; the first page comes back if it finished in time. */
export const startCostQuery = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	jobProject: string,
	query: string,
	window: CostPullWindow,
	/** One per pull: a retried call with it joins the job it started, never a second one. */
	requestId: string,
) =>
	google(httpClient, "BigQuery", BIGQUERY_URL, asReader(reader)).json(QueryPage, {
		method: "POST",
		path: `/bigquery/v2/projects/${encodeURIComponent(jobProject)}/queries`,
		body: {
			query,
			useLegacySql: false,
			parameterMode: "NAMED",
			queryParameters: [
				{
					name: "start_day",
					parameterType: { type: "DATE" },
					parameterValue: { value: window.startDay },
				},
				{
					name: "end_day",
					parameterType: { type: "DATE" },
					parameterValue: { value: window.endDay },
				},
			],
			maxResults: PAGE_ROWS,
			timeoutMs: WAIT_MS,
			maximumBytesBilled: String(MAX_BYTES_BILLED),
			labels: { "maple-purpose": "cost-sync" },
			requestId,
		},
		operation: "querying the billing export",
		timeout: CALL_TIMEOUT,
	})

/** The next result page of a started job, or its first once it finishes. */
export const getQueryPage = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	jobProject: string,
	job: { readonly jobId: string; readonly location?: string },
	pageToken: string | undefined,
) =>
	google(httpClient, "BigQuery", BIGQUERY_URL, asReader(reader)).json(QueryPage, {
		path: `/bigquery/v2/projects/${encodeURIComponent(jobProject)}/queries/${encodeURIComponent(job.jobId)}`,
		query: { location: job.location, pageToken, maxResults: PAGE_ROWS, timeoutMs: WAIT_MS },
		operation: "reading the billing export query",
		timeout: CALL_TIMEOUT,
	})
