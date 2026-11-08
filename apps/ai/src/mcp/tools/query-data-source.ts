import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Record as Rec, Schema, String as Str } from "effect"
import { QueryDataSourceOutput } from "@maple/domain/mcp-outputs"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { ResourceExternalQuery, type ExternalQuery } from "@maple/domain/data-sources"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { AGENT_AUDIENCE, mapDataSourceError, planLine, queryLanguageLabel } from "../lib/data-sources"
import { exampleQuery } from "../lib/data-source-cheat-sheet"
import { cellToString, toJson } from "./run-sql"

const TOOL = "query_data_source"
const MAX_RENDERED_ROWS = 100
const window = P.timeWindow({ defaultHours: 24, maxHours: 90 * 24 })

/** `ResourceExternalQuery` without its tag: the tool adds it, so a model never has to. */
const { _tag: _resourceTag, ...resourceQueryFields } = ResourceExternalQuery.fields
const ResourceQueryInput = Schema.Struct(resourceQueryFields)

export function registerQueryDataSourceTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Query Data Source",
		description:
			"Run one read-only query against a connected data source (an external database or API, not Maple's own " +
			"telemetry) and return its rows, capped. Send exactly one of `sql` (database data sources; macros " +
			"$__timeFilter(col), $__timeGroup(col), $__interval_s, $__from, $__to bind the time window) or `resource` " +
			"(API data sources such as Clerk; a JSON resource query). The wrong form is refused with the right one. " +
			"The answer starts with the data source, its query language and the plan (the SQL as sent, or the API " +
			"calls and rows it reads); `explain=true` returns only the plan without running anything. Call " +
			"describe_data_source first for entry and field names. For Maple's own traces, logs and metrics use " +
			"run_sql or query_data instead.",
		parameters: Schema.Struct({
			data_source: P.text(
				"Data source name (from list_data_sources or search_data_sources), e.g. shop-prod",
			),
			sql: P.optionalText("One read-only SELECT, for database data sources"),
			resource: P.optionalJson(
				ResourceQueryInput,
				'A resource query, for API data sources, e.g. {"resource":"users","measure":{"fn":"count"},"groupBy":{"time":"created_at"}}',
			),
			...window.fields,
			granularity_seconds: P.optionalNumber(
				"Bucket size for $__timeGroup or a resource time group. Default: picked from the window.",
			),
			explain: P.optionalFlag(
				"Plan the query (SQL as sent, or API calls and rows) without running it (default false)",
			),
		}),
		aliases: { source: "data_source", query: "sql" },
		output: QueryDataSourceOutput,
		hints: { readOnly: true, openWorld: true },
		phrases: ["Querying a data source", "Running a data source query"],
		handler: Effect.fn("McpTool.queryDataSource")(function* (params) {
			const sql = params.sql === undefined ? undefined : Str.trim(params.sql)
			const hasSql = sql !== undefined && sql !== ""
			const resource = params.resource
			if (hasSql === (resource !== undefined)) {
				return yield* new McpInvalidInputError({
					message: hasSql
						? "Send `sql` or `resource`, not both."
						: "Send the query: `sql` for a database data source, or `resource` for an API data source.",
					parameter: "sql",
				})
			}
			const query: ExternalQuery =
				resource === undefined ? { _tag: "sql", sql: sql ?? "" } : { _tag: "resource", ...resource }
			const { st, et } = yield* window.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			const service = yield* ExternalDataSourceService
			const source = yield* service
				.get(tenant.orgId, params.data_source, AGENT_AUDIENCE)
				.pipe(mapDataSourceError(TOOL))
			// The wrong form for this source: answer with the right one, as a worked example from its catalog.
			const wantsSql = source.queryLanguage !== "resource"
			if (wantsSql !== (query._tag === "sql")) {
				const view = yield* service
					.catalog(tenant.orgId, source.name, AGENT_AUDIENCE)
					.pipe(mapDataSourceError(TOOL))
				const example = exampleQuery(source.queryLanguage, view.entries)
				return yield* new McpInvalidInputError({
					message: wantsSql
						? `"${source.name}" is a ${source.kind} database: send SQL in \`sql\`, not a resource query. Example: ${example}`
						: `"${source.name}" is a ${source.kind} API: send a resource query in \`resource\`, not SQL. Example: ${example}`,
					parameter: wantsSql ? "resource" : "sql",
				})
			}
			const granularity =
				params.granularity_seconds === undefined
					? undefined
					: Math.max(1, Math.round(params.granularity_seconds))
			const result = yield* service
				.query(
					tenant.orgId,
					source.name,
					query,
					{
						startMs: parseWarehouseDateTime(st),
						endMs: parseWarehouseDateTime(et),
						workload: "interactive",
						explain: params.explain === true,
						...(granularity === undefined ? undefined : { granularitySeconds: granularity }),
					},
					AGENT_AUDIENCE,
				)
				.pipe(mapDataSourceError(TOOL, "data_source"))
			yield* Effect.annotateCurrentSpan({
				"maple.data_source.kind": source.kind,
				"maple.data_source.executed": result.executed,
				"maple.data_source.rows": result.rows.length,
			})
			const shown = result.rows.slice(0, MAX_RENDERED_ROWS)
			return {
				source: source.name,
				kind: source.kind,
				queryLanguage: result.language,
				environment: source.environment,
				plan: result.plan,
				executed: result.executed,
				timeRange: { start: st, end: et },
				...(granularity === undefined ? undefined : { granularitySeconds: granularity }),
				columns: [...result.columns],
				rows: Arr.map(shown, (row) => Rec.map(row, toJson)),
				rowCount: result.rows.length,
				sourceTruncated: result.truncated,
				truncated: result.rows.length > shown.length,
			}
		}),
		render: (output) => {
			const lead = doc.text(
				`Data source \`${output.source}\` (${queryLanguageLabel(output.queryLanguage)}, ${output.kind}, ${output.environment}). Plan: ${planLine(output.plan)}`,
			)
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				[
					"Granularity",
					output.granularitySeconds === undefined ? undefined : `${output.granularitySeconds}s`,
				],
			]
			if (!output.executed) {
				return {
					title: `Plan for ${output.source}`,
					scope,
					blocks: [lead, doc.text("Explain only: nothing ran. Drop `explain` to run it.")],
				}
			}
			const columns = Arr.map(output.columns, (column) => column.name)
			return {
				title: `${output.source} result`,
				scope: [...scope, ["Rows", String(output.rowCount)]],
				blocks: [
					lead,
					...(output.rowCount === 0
						? []
						: [
								doc.table(
									columns,
									Arr.map(output.rows, (row) =>
										Arr.map(columns, (name) => cellToString(row[name])),
									),
								),
							]),
				],
				...(output.rowCount === 0
					? { empty: { message: "The query returned no rows." } }
					: undefined),
				...(output.sourceTruncated
					? {
							notices: [
								"The data source's row cap cut the result; aggregate or add a LIMIT to see all of it.",
							],
						}
					: undefined),
				...(output.truncated
					? {
							truncation: {
								shown: output.rows.length,
								total: output.rowCount,
								noun: "rows (aggregate or add a LIMIT)",
							},
						}
					: undefined),
			}
		},
	})
}
