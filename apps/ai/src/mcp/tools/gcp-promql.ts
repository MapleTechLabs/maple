/**
 * Live reads of the org's Google Cloud Monitoring metrics through Google's PromQL API. Nothing here
 * touches the warehouse: the ingested `gcp.*` metrics stay with list_metrics and query_data.
 */
import { Effect, Schema } from "effect"
import {
	GcpMetricType,
	GcpPromQlInstantRequest,
	GcpPromQlRangeRequest,
	type IntegrationsNotFoundError,
} from "@maple/domain/http"
import { FindGcpMetricsOutput, QueryGcpPromQlOutput } from "@maple/domain/mcp-outputs"
import { GcpProjectId } from "@maple/domain/primitives"
import { type GcpPromQlError, GcpPromQlService } from "@maple/backend/services/integrations/GcpPromQlService"
import { computeBucketSecondsForRange } from "@maple/query-engine"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { truncate } from "../lib/format"
import { doc, type NextCall } from "../lib/tool-doc"
import {
	type McpToolError,
	McpInvalidInputError,
	McpNotReadyError,
	McpQueryError,
	McpUnavailableError,
	type McpToolRegistrar,
} from "./types"

/** Google keeps most system metrics six weeks. */
const WINDOW = P.timeWindow({ defaultHours: 1, maxHours: 42 * 24 })
/** Series kept in the output (the chat chart's payload), highest last value first. */
const MAX_SERIES = 100
/** Series the model reads. */
const SHOWN_SERIES = 20
const DISTRIBUTION_SUFFIX = /_(bucket|count|sum)$/u
const HINTS = { readOnly: true, openWorld: true } as const

const toMcpError =
	(tool: string, projectParameter: string) =>
	(error: GcpPromQlError | IntegrationsNotFoundError): McpToolError => {
		switch (error._tag) {
			case "@maple/http/errors/GcpPromQlInvalidQueryError":
				return new McpInvalidInputError({
					message: `Google refused the query (project ${error.projectId}): ${error.message}`,
					parameter: "query",
				})
			case "@maple/http/errors/GcpPromQlTooManyProjectsError":
				return new McpInvalidInputError({
					message: `${error.message} Projects: ${error.projects.slice(0, 20).join(", ")}${error.projects.length > 20 ? ` and ${error.projects.length - 20} more` : ""}.`,
					parameter: projectParameter,
				})
			case "@maple/http/errors/GcpPromQlTooManySeriesError":
				return new McpInvalidInputError({ message: error.message, parameter: "query" })
			case "@maple/http/errors/IntegrationsValidationError":
				return new McpInvalidInputError({ message: error.message, parameter: projectParameter })
			case "@maple/http/errors/IntegrationsNotFoundError":
				return new McpInvalidInputError({
					message: `${error.message} Find the name with find_gcp_metrics search=...`,
					parameter: "metric",
				})
			case "@maple/http/errors/GcpPromQlUnavailableError":
				return new McpUnavailableError({ message: error.message, capability: "gcp_live_query" })
			case "@maple/http/errors/IntegrationsNotConnectedError":
				return new McpUnavailableError({ message: error.message, capability: "gcp_connection" })
			// Every project failed; the message says why per project and what fixes it (mostly a
			// setup-script run whose grant takes minutes to apply).
			case "@maple/http/errors/GcpPromQlFailedError":
				return new McpNotReadyError({ message: error.message, retryAfterSeconds: 300 })
			case "@maple/http/errors/IntegrationsUpstreamError":
			case "@maple/http/errors/IntegrationsPersistenceError":
				return new McpQueryError({ message: error.message, pipeName: tool, cause: error })
		}
	}

const decodeProject = (project: string | undefined) =>
	project === undefined
		? Effect.succeed(undefined)
		: Schema.decodeUnknownEffect(GcpProjectId)(project).pipe(
				Effect.mapError(
					() =>
						new McpInvalidInputError({
							message: `\`${project}\` is not a Google Cloud project id.`,
							parameter: "project",
							example: 'project="my-project-123"',
						}),
				),
			)

/** A query for a metric type's kind: rate for counters, avg for gauges, p95 for distributions. */
export const starterQuery = (metric: {
	readonly type: string
	readonly metricKind: string
	readonly valueType: string
	readonly monitoredResourceTypes: ReadonlyArray<string>
}): string | undefined => {
	if (metric.valueType === "STRING") return undefined
	// Google refuses a selector that could match several resource types.
	const resource =
		metric.monitoredResourceTypes.length > 1
			? `, monitored_resource="${metric.monitoredResourceTypes[0]}"`
			: ""
	if (metric.valueType === "DISTRIBUTION") {
		return `histogram_quantile(0.95, sum by (le) (rate({"${metric.type}_bucket"${resource}}[5m])))`
	}
	const selector = `{"${metric.type}"${resource}}`
	return metric.metricKind === "GAUGE" ? `avg(${selector})` : `sum(rate(${selector}[5m]))`
}

const seriesName = (labels: Readonly<Record<string, string>>): string => {
	const entries = Object.entries(labels).filter(([key]) => key !== "__name__")
	return `{${entries.map(([key, value]) => `${key}="${value}"`).join(", ")}}`
}

const formatValue = (value: number): string => value.toLocaleString("en-US", { maximumSignificantDigits: 4 })

const lastValue = (points: ReadonlyArray<readonly [number, number]>): number =>
	points.at(-1)?.[1] ?? Number.NEGATIVE_INFINITY

export function registerGcpPromQlTools(server: McpToolRegistrar) {
	server.define({
		name: "find_gcp_metrics",
		title: "Find Google Cloud Metrics",
		description:
			"Find Google Cloud Monitoring metric types in the connected Google Cloud projects by name substring (`search`), or describe one (`metric`): kind, value type, unit, monitored resource types, labels, and a starter PromQL query for query_gcp_promql. Reads Google live; the ingested `gcp.*` warehouse metrics are in list_metrics and query_data.",
		parameters: Schema.Struct({
			search: P.optionalText(
				"Case-insensitive substring of the metric type, e.g. `run.googleapis.com/` or `cpu/utilization`",
			),
			metric: P.optionalText(
				"A metric type to describe, e.g. `run.googleapis.com/request_latencies` (a distribution's `_bucket` name works too)",
			),
			project: P.optionalText("Project whose metrics to read (default: the first connected project)"),
			limit: P.limit({ default: 50, max: 200, noun: "metric names" }),
		}),
		output: FindGcpMetricsOutput,
		hints: HINTS,
		phrases: ["Looking up Google Cloud metrics", "Reading a Google Cloud metric"],
		handler: Effect.fn("McpTool.findGcpMetrics")(function* (params) {
			if (params.search === undefined && params.metric === undefined) {
				return yield* new McpInvalidInputError({
					message: "Pass `search` to find metric types, or `metric` to describe one.",
					parameter: "search",
					example: 'search="run.googleapis.com/request"',
				})
			}
			const metric = params.metric
			if (metric !== undefined && !Schema.is(GcpMetricType)(metric)) {
				return yield* new McpInvalidInputError({
					message: `\`${metric}\` is not a Cloud Monitoring metric type.`,
					parameter: "metric",
					example: 'metric="run.googleapis.com/request_count"',
				})
			}
			const project = yield* decodeProject(params.project)
			const tenant = yield* CurrentMcpTenant
			const gcp = yield* GcpPromQlService
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
			const fail = toMcpError("find_gcp_metrics", "project")

			const text = params.search
			const search =
				text === undefined
					? undefined
					: yield* gcp
							.searchMetrics(tenant.orgId, { search: text, limit: params.limit + 1, project })
							.pipe(
								Effect.mapError(fail),
								Effect.map((found) => ({
									text,
									projectId: found.projectId,
									metrics: found.metrics.slice(0, params.limit),
									truncated: found.metrics.length > params.limit,
								})),
							)
			const described =
				metric === undefined
					? undefined
					: yield* gcp.describeMetric(tenant.orgId, { type: metric, project }).pipe(
							Effect.mapError(fail),
							Effect.map((descriptor) => {
								const query = starterQuery(descriptor)
								return {
									type: descriptor.type,
									metricKind: descriptor.metricKind,
									valueType: descriptor.valueType,
									unit: descriptor.unit,
									description: descriptor.description,
									monitoredResourceTypes: descriptor.monitoredResourceTypes,
									labels: descriptor.labels,
									...(query === undefined ? undefined : { starterQuery: query }),
								}
							}),
						)
			return {
				...(search === undefined ? undefined : { search }),
				...(described === undefined ? undefined : { metric: described }),
			}
		}),
		render: (output) => {
			const { search, metric } = output
			// A distribution lists as `_bucket`, `_count` and `_sum`: one type. `request_count` alone is its own.
			const names = search?.metrics ?? []
			const distributions = new Set(
				names
					.filter((name) => name.endsWith("_bucket"))
					.map((name) => name.slice(0, -"_bucket".length)),
			)
			const types = [
				...new Set(
					names.map((name) => {
						const base = name.replace(DISTRIBUTION_SUFFIX, "")
						return distributions.has(base) ? base : name
					}),
				),
			]
			const resources = metric?.monitoredResourceTypes ?? []
			return {
				title: "Google Cloud Metrics",
				scope: [
					["Project", search?.projectId],
					["Search", search?.text],
				],
				...(search !== undefined && search.metrics.length === 0
					? {
							empty: {
								message: `No metric type in project ${search.projectId} contains "${search.text}".`,
								hints: [
									"Search a shorter piece of the name, or the service prefix such as `run.googleapis.com/` or `compute.googleapis.com/`.",
								],
							},
						}
					: undefined),
				blocks: [
					...(search === undefined || search.metrics.length === 0
						? []
						: [
								doc.list(search.metrics),
								doc.text(
									"Names ending `_bucket`, `_count`, `_sum` are one distribution. A listed name has a descriptor, not necessarily data.",
								),
							]),
					...(metric === undefined
						? []
						: [
								doc.heading(metric.type),
								doc.fields([
									["Kind", metric.metricKind],
									["Value type", metric.valueType],
									["Unit", metric.unit === "" ? "-" : metric.unit],
									["Resource types", resources.join(", ")],
									["Description", metric.description],
								]),
								...(metric.labels.length === 0
									? []
									: [
											doc.table(
												["Label", "Description"],
												metric.labels.map((label) => [
													label.key,
													truncate(label.description, 100),
												]),
											),
										]),
								...(metric.starterQuery === undefined
									? [doc.text("PromQL cannot read STRING metrics.")]
									: [
											doc.code("promql", metric.starterQuery),
											...(resources.length > 1
												? [
														doc.text(
															`The \`monitored_resource\` matcher is required: the starter query reads ${resources[0]}; the metric also exists for ${resources.slice(1).join(", ")}.`,
														),
													]
												: []),
										]),
							]),
				],
				...(search?.truncated === true
					? {
							truncation: {
								shown: search.metrics.length,
								noun: "metric names; narrow `search` for the rest",
							},
						}
					: undefined),
				next: [
					...(metric?.starterQuery === undefined
						? []
						: [
								doc.next(
									"query_gcp_promql",
									{ query: metric.starterQuery },
									"run the starter query",
								),
							]),
					...types
						.slice(0, 3)
						.map((type) =>
							doc.next(
								"find_gcp_metrics",
								{ metric: type, project: search?.projectId },
								"its kind, labels and a starter query",
							),
						),
				],
			}
		},
	})

	server.define({
		name: "query_gcp_promql",
		title: "Query Google Cloud Metrics",
		description:
			'Run PromQL live against Google Cloud Monitoring in every connected Google Cloud project (or the `projects` named), over the window (kind=timeseries) or once at end_time (kind=instant). Aggregate with `sum by (...)` or `avg by (...)`: Google bills per time series returned. Metric names use the UTF-8 form `{"run.googleapis.com/request_count", monitored_resource="cloud_run_revision"}`; a metric with several resource types needs the `monitored_resource` matcher. Each project is queried on its own, so aggregation stays within a project and every series carries `project_id`. Get names and a starter query from find_gcp_metrics. These are live Google reads, separate from the ingested `gcp.*` warehouse metrics in query_data.',
		parameters: Schema.Struct({
			query: P.text(
				'PromQL, e.g. `sum by (service_name) (rate({"run.googleapis.com/request_count", monitored_resource="cloud_run_revision"}[5m]))`',
			),
			kind: P.optionalOneOf(
				["timeseries", "instant"],
				"timeseries (default): points over the window; instant: one value per series at end_time",
			),
			...WINDOW.fields,
			bucket_seconds: P.optionalNumber(
				"Point spacing in seconds, 60 to 86400 (timeseries only; default: from the window, about 100 points)",
			),
			projects: P.optionalList(
				"Only these Google Cloud project ids, at most 20 (default: every connected project)",
			),
		}),
		output: QueryGcpPromQlOutput,
		hints: HINTS,
		phrases: ["Querying Google Cloud", "Reading Google Cloud metrics"],
		handler: Effect.fn("McpTool.queryGcpPromQl")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "query_gcp_promql")
			const tenant = yield* CurrentMcpTenant
			const gcp = yield* GcpPromQlService
			const kind = params.kind ?? "timeseries"
			const query = params.query.trim()
			const projects = params.projects === undefined ? undefined : { projects: params.projects }
			const stepSeconds = Math.min(
				86_400,
				Math.max(60, Math.floor(params.bucket_seconds ?? computeBucketSecondsForRange(st, et))),
			)
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.ai.kind": kind })
			// The request schema names the step by its HTTP name.
			const invalid = (error: Schema.SchemaError) =>
				new McpInvalidInputError({
					message: error.message.replaceAll("stepSeconds", "bucket_seconds"),
				})
			const fail = toMcpError("query_gcp_promql", "projects")

			const result =
				kind === "instant"
					? yield* Schema.decodeUnknownEffect(GcpPromQlInstantRequest)({
							query,
							time: et,
							...projects,
						}).pipe(
							Effect.mapError(invalid),
							Effect.flatMap((request) =>
								gcp.queryInstant(tenant.orgId, request).pipe(Effect.mapError(fail)),
							),
						)
					: yield* Schema.decodeUnknownEffect(GcpPromQlRangeRequest)({
							query,
							startTime: st,
							endTime: et,
							stepSeconds,
							...projects,
						}).pipe(
							Effect.mapError(invalid),
							Effect.flatMap((request) =>
								gcp.queryRange(tenant.orgId, request).pipe(Effect.mapError(fail)),
							),
						)
			yield* Effect.annotateCurrentSpan("result.seriesCount", result.series.length)
			return {
				query,
				kind,
				timeRange: { start: st, end: et },
				...(kind === "timeseries" ? { stepSeconds } : undefined),
				series: [...result.series]
					.sort((a, b) => lastValue(b.points) - lastValue(a.points))
					.slice(0, MAX_SERIES),
				totalSeries: result.series.length,
				projects: result.projects,
				failures: result.failures,
			}
		}),
		render: (output) => {
			const instant = output.kind === "instant"
			const shown = output.series.slice(0, SHOWN_SERIES)
			// A distribution's `_bucket` name describes too.
			const metricType = /\{\s*"([^"]+)"/u.exec(output.query)?.[1]
			const rows = shown.map((series) => {
				const values = series.points.map(([, value]) => value)
				const name = truncate(seriesName(series.labels), 120)
				if (instant) return [name, values.length === 0 ? "-" : formatValue(values[0])]
				if (values.length === 0) return [name, "-", "-", "-", "-", "0"]
				return [
					name,
					formatValue(values[values.length - 1]),
					formatValue(Math.min(...values)),
					formatValue(values.reduce((sum, value) => sum + value, 0) / values.length),
					formatValue(Math.max(...values)),
					String(values.length),
				]
			})
			const next: Array<NextCall> = [
				...(metricType === undefined
					? []
					: [
							doc.next(
								"find_gcp_metrics",
								{ metric: metricType },
								"its kind, labels and resource types",
							),
						]),
				...(instant
					? [
							doc.next(
								"query_gcp_promql",
								{
									query: output.query,
									start_time: output.timeRange.start,
									end_time: output.timeRange.end,
								},
								"the same query over the window",
							),
						]
					: []),
			]
			return {
				title: "Google Cloud PromQL",
				scope: [
					[
						instant ? "At" : "Window",
						instant
							? output.timeRange.end
							: `${output.timeRange.start} to ${output.timeRange.end}`,
					],
					["Step", output.stepSeconds === undefined ? undefined : `${output.stepSeconds}s`],
					["Projects", output.projects.join(", ")],
				],
				notices: [
					"Read live from Google Cloud Monitoring, one call per project: aggregation stays within a project and every series carries `project_id`.",
					...(output.totalSeries > SHOWN_SERIES
						? [
								"Aggregate with `sum by (...)` or `avg by (...)` to cut the series: Google bills per series returned.",
							]
						: []),
				],
				...(output.totalSeries === 0
					? {
							empty: {
								message: "Google returned no series.",
								hints: [
									"The metric may have no data in this window: widen start_time, or check the name with find_gcp_metrics.",
									"An instant query looks back 5 minutes; a sparse metric needs kind=timeseries or a range selector.",
								],
							},
						}
					: undefined),
				blocks: [
					doc.code("promql", output.query),
					...(rows.length === 0
						? []
						: [
								doc.table(
									instant
										? ["Series", "Value"]
										: ["Series", "Last", "Min", "Avg", "Max", "Points"],
									rows,
								),
							]),
					...(output.failures.length === 0
						? []
						: [
								doc.heading("Not read"),
								doc.list(
									output.failures.map((failure) => `${failure.scope}: ${failure.message}`),
								),
							]),
				],
				...(output.totalSeries > shown.length
					? {
							truncation: {
								shown: shown.length,
								total: output.totalSeries,
								noun: "series, highest last value first",
							},
						}
					: undefined),
				next,
			}
		},
	})
}
