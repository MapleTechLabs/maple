import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { queryWarehouse, withTenantExecutor } from "../lib/query-warehouse"
import { CurrentMcpTenant } from "../tenant"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall, type ToolDoc } from "../lib/tool-doc"
import { Effect, Schema, Array as Arr } from "effect"
import { ExploreAttributesOutput } from "@maple/domain/mcp-outputs"
import {
	exploreAttributeKeys,
	exploreAttributeValues,
	productEventAttributeKeys,
	productEventAttributeValues,
} from "@maple/query-engine/observability"
import { MetricType } from "@maple/domain/query-engine"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_DISCOVERY_MAX_HOURS })
/** Product events are sparse next to spans: a week is what finds a rarely fired event's props. */
const EVENTS_WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })

type Output = typeof ExploreAttributesOutput.Type

interface ServicesFacetRow {
	readonly facetType: string
	readonly name: string
	readonly count?: number | string
}

const timeScope = (output: Output): ToolDoc["scope"] => [
	["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
	["Service", output.service],
]

// Metric labels are their own scope; span/resource scoping only applies to traces.
const sourceLabelOf = (output: Output): string =>
	output.source === "metrics"
		? output.metricName === undefined
			? "metrics (all sum metrics)"
			: `metrics (${output.metricName})`
		: output.source === "product_events"
			? output.eventName === undefined
				? "product events (every event)"
				: `product events (${output.eventName})`
			: `${output.source} (${output.scope ?? "span"})`

/** What narrows a product-event read: the event its props were read from. */
const eventScope = (output: Output) =>
	output.eventName === undefined ? undefined : { event_name: [output.eventName] }

const renderValues = (output: Output, key: string): ToolDoc => {
	const values = output.values ?? []
	const sourceLabel = sourceLabelOf(output)
	const next: NextCall =
		output.source === "product_events"
			? doc.next(
					"query_data",
					{
						source: "product_events",
						kind: "breakdown",
						group_by: "attribute",
						attribute_key: key,
						...eventScope(output),
					},
					"count events per value of this property",
				)
			: output.source === "metrics"
				? doc.next(
						"query_data",
						{
							source: "metrics",
							kind: "breakdown",
							group_by: "attribute",
							attribute_key: key,
							metric_name: output.metricName,
							metric_type: output.metricType,
							service: output.service,
						},
						output.metricName === undefined
							? "break a metric down by this label (add metric_name and metric_type)"
							: "break this metric down by this label",
					)
				: doc.next(
						"query_data",
						{
							source: "traces",
							kind: "timeseries",
							attribute_key: key,
							...(values[0] === undefined ? undefined : { attribute_value: values[0].value }),
						},
						"chart traces filtered by this attribute",
					)
	return {
		title: `Attribute Values: ${key}`,
		scope: [["Source", sourceLabel], ...(timeScope(output) ?? [])],
		...(values.length === 0 ? { empty: { message: "No values found for this key." } } : undefined),
		blocks:
			values.length === 0
				? []
				: [
						doc.table(
							["Value", "Count"],
							Arr.map(values, (v) => [v.value, formatNumber(v.count)]),
						),
					],
		next: [next],
	}
}

const renderServices = (output: Output): ToolDoc => {
	const environments = output.environments ?? []
	const commitShas = output.commitShas ?? []
	const blocks: Array<DocBlock> = []
	if (environments.length > 0) {
		blocks.push(
			doc.heading("Environments"),
			doc.table(
				["Environment", "Span Count"],
				Arr.map(environments, (r) => [r.name, formatNumber(r.count)]),
			),
		)
	}
	if (commitShas.length > 0) {
		blocks.push(
			doc.heading("Commit SHAs"),
			doc.table(
				["Commit SHA", "Span Count"],
				Arr.map(commitShas, (r) => [r.name, formatNumber(r.count)]),
			),
		)
	}
	return {
		title: "Available Environments & Deployments",
		scope: timeScope(output),
		...(blocks.length === 0
			? { empty: { message: "No environments or commit SHAs found in this window." } }
			: undefined),
		blocks,
		next: [
			...Arr.map(environments.slice(0, 1), (env) =>
				doc.next("list_services", { environment: env.name }, "see services in this environment"),
			),
			...(commitShas.length > 1
				? [doc.next("compare_periods", {}, "compare performance between deploys")]
				: []),
		],
	}
}

const renderKeys = (output: Output): ToolDoc => {
	const keys = output.keys ?? []
	const source =
		output.source === "metrics" || output.source === "product_events" ? output.source : "traces"
	const unscopedMetrics = output.source === "metrics" && output.metricName === undefined
	const rollupNote = unscopedMetrics
		? [
				doc.text(
					"Keys from an org-wide rollup of sum metrics (span-metrics labels included; gauges and " +
						"histograms are not). Pass metric_name for one metric's own labels.",
				),
			]
		: []
	return {
		title: "Attribute Keys",
		scope: [["Source", sourceLabelOf(output)], ...(timeScope(output) ?? [])],
		...(keys.length === 0
			? {
					empty: {
						message:
							output.metricName === undefined
								? "No attribute keys found."
								: `No attribute keys found for ${output.metricName}. Check the name and type with list_metrics.`,
					},
				}
			: undefined),
		blocks: [
			...rollupNote,
			...(keys.length === 0
				? []
				: [
						doc.table(
							["Key", "Count"],
							Arr.map(keys, (k) => [k.key, formatNumber(k.count)]),
						),
						...(output.service !== undefined && output.source === "traces"
							? [doc.text("Counts are from a sample of up to 20,000 of this service's spans.")]
							: []),
					]),
		],
		next: Arr.map(keys.slice(0, 3), (k) =>
			doc.next(
				"explore_attributes",
				{
					source,
					key: k.key,
					...(output.scope === undefined ? undefined : { scope: output.scope }),
					...(output.metricName === undefined ? undefined : { metric_name: output.metricName }),
					...(output.metricType === undefined ? undefined : { metric_type: output.metricType }),
					...(output.service === undefined ? undefined : { service: output.service }),
					...(output.eventName === undefined ? undefined : { event_name: output.eventName }),
				},
				"see values for this key",
			),
		),
	}
}

export function registerExploreAttributesTool(server: McpToolRegistrar) {
	server.define({
		name: "explore_attributes",
		title: "Explore Attributes",
		description:
			"Discover attribute keys and their values, for filtering in query_data and search_traces. " +
			"source=product_events lists the properties `track()` and server events carry (narrow to one event with event_name). " +
			"source=services instead lists the environments and commit SHAs seen in the window.",
		parameters: Schema.Struct({
			source: P.oneOf(
				["traces", "metrics", "product_events", "services"],
				"'traces' for span or resource attributes, 'metrics' for metric labels, 'product_events' for event properties, 'services' for environments and commit SHAs",
			),
			scope: P.optionalOneOf(
				["span", "resource"],
				"Span or resource attributes (traces only; default span)",
			),
			metric_name: P.optionalText(
				"source=metrics: list this metric's own data-point labels (any metric type). Without it, keys come " +
					"from an org-wide rollup of sum metrics only",
			),
			metric_type: P.optionalOneOf(
				MetricType.literals,
				"Type of metric_name, as list_metrics reports it (looked up when omitted)",
			),
			event_name: P.optionalText(
				"source=product_events: only properties of this event (exact name, from list_product_events)",
			),
			key: P.optionalText("Return this key's values instead of the key list"),
			service: P.service(
				"Only this service (exact `service.name`). For product_events, the service that sent a server-side event. Not applied for source=services",
			),
			...WINDOW.fields,
			start_time: WINDOW.fields.start_time.annotate({
				description:
					"Window start, UTC (YYYY-MM-DD HH:mm:ss). Default: 6 hours before end_time, or 7 days for product_events. Covers at most 30 days.",
			}),
			limit: P.limit({
				default: 50,
				max: 500,
				noun: "keys or values (not applied for source=services)",
			}),
		}),
		aliases: P.SERVICE_ALIASES,
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Exploring attributes", "Looking up attribute values"],
		handler: Effect.fn("McpTool.exploreAttributes")(function* (params) {
			const { st, et } = yield* (params.source === "product_events" ? EVENTS_WINDOW : WINDOW).resolve(
				params,
				"explore_attributes",
			)
			const scope = params.scope ?? "span"
			const tenant = yield* CurrentMcpTenant
			const provideExecutor = provideWarehouseExecutorFromTenant(tenant)
			const mapError = toMcpQueryError("explore_attributes")
			const timeRange = { start: st, end: et }
			const serviceField = params.service === undefined ? undefined : { service: params.service }

			if (params.source !== "product_events" && params.event_name !== undefined) {
				return yield* new McpInvalidInputError({
					message: `\`event_name\` applies to source=product_events only; source=${params.source} has no events to narrow to.`,
					parameter: "event_name",
				})
			}
			if (params.source === "product_events") {
				const events = {
					startTime: st,
					endTime: et,
					limit: params.limit,
					...(params.event_name === undefined ? undefined : { eventName: params.event_name }),
					...(params.service === undefined ? undefined : { service: params.service }),
				}
				const eventField = {
					...(params.event_name === undefined ? undefined : { eventName: params.event_name }),
					...serviceField,
				}
				if (params.key !== undefined) {
					const rows = yield* withTenantExecutor(
						productEventAttributeValues({ ...events, key: params.key }),
					).pipe(Effect.mapError(mapError))
					return {
						source: params.source,
						key: params.key,
						timeRange,
						values: Arr.map(rows, (row) => ({
							value: row.attributeValue,
							count: row.usageCount,
						})),
						...eventField,
					}
				}
				const rows = yield* withTenantExecutor(productEventAttributeKeys(events)).pipe(
					Effect.mapError(mapError),
				)
				return {
					source: params.source,
					timeRange,
					keys: Arr.map(rows, (row) => ({ key: row.attributeKey, count: row.usageCount })),
					...eventField,
				}
			}

			const isMetrics = params.source === "metrics"
			const metricField =
				isMetrics && params.metric_name !== undefined
					? {
							metricName: params.metric_name,
							...(params.metric_type === undefined
								? undefined
								: { metricType: params.metric_type }),
						}
					: undefined
			// Span/resource scoping is a traces concept; metrics output carries none.
			const scopeField = params.source === "traces" ? { scope } : undefined
			const baseInput = {
				source: params.source,
				scope,
				service: params.service,
				timeRange: { startTime: st, endTime: et },
				limit: params.limit,
				...metricField,
			}

			if (params.key !== undefined) {
				const values = yield* exploreAttributeValues({ ...baseInput, key: params.key }).pipe(
					provideExecutor,
					Effect.mapError(mapError),
				)
				return {
					source: params.source,
					...scopeField,
					key: params.key,
					timeRange,
					values: Arr.map(values, (v) => ({ value: v.value, count: v.count })),
					...serviceField,
					...metricField,
				}
			}

			if (params.source === "services") {
				const result = yield* queryWarehouse<ServicesFacetRow>("services_facets", {
					start_time: st,
					end_time: et,
				})
				const facet = (type: string) =>
					Arr.map(
						Arr.filter(result.data, (r) => r.facetType === type),
						(r) => ({ name: r.name, count: Number(r.count ?? 0) }),
					)
				const environments = facet("environment")
				const commitShas = facet("commit_sha")
				return {
					source: "services",
					timeRange,
					keys: [
						...Arr.map(environments, (r) => ({ key: `environment:${r.name}`, count: r.count })),
						...Arr.map(commitShas, (r) => ({ key: `commit_sha:${r.name}`, count: r.count })),
					],
					environments,
					commitShas,
				}
			}

			const keys = yield* exploreAttributeKeys(baseInput).pipe(
				provideExecutor,
				Effect.mapError(mapError),
			)
			return {
				source: params.source,
				...scopeField,
				timeRange,
				keys: Arr.map(keys, (k) => ({ key: k.key, count: k.count })),
				...serviceField,
				...metricField,
			}
		}),
		render: (output) =>
			output.key !== undefined
				? renderValues(output, output.key)
				: output.source === "services"
					? renderServices(output)
					: renderKeys(output),
	})
}
