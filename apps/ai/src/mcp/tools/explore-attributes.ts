import type { McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { CurrentMcpTenant, queryWarehouse } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall, type ToolDoc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { ExploreAttributesOutput } from "@maple/domain/mcp-outputs"
import { exploreAttributeKeys, exploreAttributeValues } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_DISCOVERY_MAX_HOURS })

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

const renderValues = (output: Output, key: string): ToolDoc => {
	const values = output.values ?? []
	// Metric labels are their own scope; span/resource scoping only applies to traces.
	const sourceLabel =
		output.source === "metrics" ? "metrics" : `${output.source} (${output.scope ?? "span"})`
	const next: NextCall =
		output.source === "metrics"
			? doc.next(
					"query_data",
					{ source: "metrics", kind: "breakdown", group_by: "attribute", attribute_key: key },
					"break a metric down by this label (add metric_name and metric_type)",
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
							values.map((v) => [v.value, formatNumber(v.count)]),
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
				environments.map((r) => [r.name, formatNumber(r.count)]),
			),
		)
	}
	if (commitShas.length > 0) {
		blocks.push(
			doc.heading("Commit SHAs"),
			doc.table(
				["Commit SHA", "Span Count"],
				commitShas.map((r) => [r.name, formatNumber(r.count)]),
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
			...environments
				.slice(0, 1)
				.map((env) =>
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
	const source = output.source === "metrics" ? "metrics" : "traces"
	return {
		title: "Attribute Keys",
		scope: [["Source", `${output.source} (${output.scope ?? "span"})`], ...(timeScope(output) ?? [])],
		...(keys.length === 0 ? { empty: { message: "No attribute keys found." } } : undefined),
		blocks:
			keys.length === 0
				? []
				: [
						doc.table(
							["Key", "Count"],
							keys.map((k) => [k.key, formatNumber(k.count)]),
						),
					],
		next: keys
			.slice(0, 3)
			.map((k) =>
				doc.next(
					"explore_attributes",
					{
						source,
						key: k.key,
						...(output.scope === undefined ? undefined : { scope: output.scope }),
					},
					"see values for this key",
				),
			),
	}
}

export function registerExploreAttributesTool(server: McpToolRegistrar) {
	server.define({
		name: "explore_attributes",
		description:
			"Discover available attribute keys and their values. Call this before query_data or search_traces when you need to filter by custom attributes. " +
			"Use source=services to discover available environments and commit SHAs for comparison.",
		parameters: Schema.Struct({
			source: P.oneOf(
				["traces", "metrics", "services"],
				"Data source. Use 'traces' to discover span/resource attribute keys (e.g. http.method, user.id). " +
					"Use 'metrics' to discover metric attribute keys. " +
					"Use 'services' to discover available environments and commit SHAs.",
			),
			scope: P.optionalOneOf(
				["span", "resource"],
				"Attribute scope for traces: 'span' (default) or 'resource'. Ignored for metrics/services.",
			),
			key: P.optionalText("When provided, returns values for this key instead of listing all keys"),
			service: P.service(),
			...WINDOW.fields,
			limit: P.limit({ default: 50, max: 500, noun: "keys or values" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ExploreAttributesOutput,
		hints: { readOnly: true },
		phrases: ["Exploring attributes", "Looking up attribute values"],
		handler: Effect.fn("McpTool.exploreAttributes")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "explore_attributes")
			const scope = params.scope ?? "span"
			const tenant = yield* CurrentMcpTenant
			const provideExecutor = provideWarehouseExecutorFromTenant(tenant)
			const mapError = toMcpQueryError("explore_attributes")
			const timeRange = { start: st, end: et }
			const serviceField = params.service === undefined ? undefined : { service: params.service }

			const baseInput = {
				source: params.source,
				scope,
				service: params.service,
				timeRange: { startTime: st, endTime: et },
				limit: params.limit,
			}

			if (params.key !== undefined) {
				const values = yield* exploreAttributeValues({ ...baseInput, key: params.key }).pipe(
					provideExecutor,
					Effect.mapError(mapError),
				)
				return {
					source: params.source,
					scope,
					key: params.key,
					timeRange,
					values: values.map((v) => ({ value: v.value, count: v.count })),
					...serviceField,
				}
			}

			// The services source reads a different pipe.
			if (params.source === "services") {
				const result = yield* queryWarehouse<ServicesFacetRow>("services_facets", {
					start_time: st,
					end_time: et,
				})
				const facet = (type: string) =>
					result.data
						.filter((r) => r.facetType === type)
						.map((r) => ({ name: String(r.name), count: Number(r.count ?? 0) }))
				const environments = facet("environment")
				const commitShas = facet("commit_sha")
				return {
					source: "services",
					timeRange,
					keys: [
						...environments.map((r) => ({ key: `environment:${r.name}`, count: r.count })),
						...commitShas.map((r) => ({ key: `commit_sha:${r.name}`, count: r.count })),
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
				scope,
				timeRange,
				keys: keys.map((k) => ({ key: k.key, count: k.count })),
				...serviceField,
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
