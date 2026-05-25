import { Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { CliConfig } from "./CliConfig"

export class MapleApiError extends Schema.TaggedErrorClass<MapleApiError>()(
	"@maple/cli/services/MapleApiError",
	{
		message: Schema.String,
		queryName: Schema.optionalKey(Schema.String),
	},
) {}

export interface MapleClientShape {
	readonly queryWarehouse: <T = unknown>(
		queryName: WarehouseQueryName,
		params?: Record<string, unknown>,
	) => Effect.Effect<{ data: Array<T> }, MapleApiError>

	readonly callTool: (
		name: string,
		args: Record<string, unknown>,
	) => Effect.Effect<Record<string, unknown>, MapleApiError>

	readonly queryEngine: (request: {
		startTime: string
		endTime: string
		query: unknown
	}) => Effect.Effect<{ result: unknown }, MapleApiError>
}

export class MapleClient extends Context.Service<MapleClient, MapleClientShape>()("@maple/cli/services/MapleClient", {
	make: Effect.gen(function* () {
		const config = yield* CliConfig
		const mcpUrl = config.mcpUrl
		const token = Redacted.value(config.apiToken)

		// JSON-RPC request id counter + MCP session id, held in Refs so the state
		// lives with the service instance instead of leaking module-level mutables.
		const nextIdRef = yield* Ref.make(1)
		const sessionIdRef = yield* Ref.make<string | null>(null)
		const nextId = Ref.getAndUpdate(nextIdRef, (n) => n + 1)

		const ensureSession = Effect.gen(function* () {
			const existing = yield* Ref.get(sessionIdRef)
			if (existing) return existing

			const id = yield* nextId
			const sid = yield* Effect.tryPromise({
				try: () =>
					fetch(mcpUrl, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id,
							method: "initialize",
							params: {
								protocolVersion: "2024-11-05",
								capabilities: {},
								clientInfo: { name: "maple-cli", version: "0.1.0" },
							},
						}),
					}),
				catch: (error) =>
					new MapleApiError({
						message: `MCP init failed: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})

			const header = sid.headers.get("mcp-session-id")
			if (!header) {
				return yield* new MapleApiError({ message: "No Mcp-Session-Id header in response" })
			}

			yield* Ref.set(sessionIdRef, header)
			return header
		})

		const callTool = Effect.fn("MapleClient.callTool")(function* (
			name: string,
			args: Record<string, unknown>,
		) {
			const sid = yield* ensureSession
			const id = yield* nextId

			const result = yield* Effect.tryPromise({
				try: () =>
					fetch(mcpUrl, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
							"mcp-session-id": sid,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id,
							method: "tools/call",
							params: { name, arguments: args },
						}),
					}).then(async (resp) => {
						if (!resp.ok) {
							const text = await resp.text()
							return { __httpError: `HTTP ${resp.status}: ${text}` } as const
						}
						return (await resp.json()) as Record<string, unknown>
					}),
				catch: (error) =>
					new MapleApiError({
						message: `MCP tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})

			if ("__httpError" in result) {
				return yield* new MapleApiError({ message: `MCP tool ${name} failed: ${result.__httpError}` })
			}

			const res = result as Record<string, any>
			if (res.error) {
				return yield* new MapleApiError({ message: `MCP error: ${JSON.stringify(res.error)}` })
			}

			// Extract structured data from the dual content format
			// Second text content item contains JSON with __maple_ui marker
			const content = res.result?.content ?? []
			const textContent = content
				.filter((c: any) => c.type === "text" && !c.text?.includes("__maple_ui"))
				.map((c: any) => c.text)
				.join("\n")

			for (const c of content) {
				if (c.type === "text" && c.text?.includes("__maple_ui")) {
					try {
						const parsed = JSON.parse(c.text) as Record<string, unknown>
						// Preserve both structured data and human-readable text
						parsed._text = textContent
						return parsed
					} catch {
						// fall through
					}
				}
			}

			// Return raw text content if no structured data found
			return { _raw: true, text: textContent, content } as Record<string, unknown>
		})

		// Query Tinybird pipes by calling MCP tools that wrap them
		// We map pipe names to MCP tool calls
		const PIPE_TO_TOOL: Record<string, string> = {
			service_overview: "list_services",
			errors_by_type: "find_errors",
			list_traces: "search_traces",
			span_hierarchy: "inspect_trace",
			list_logs: "search_logs",
			error_detail_traces: "error_detail",
			service_dependencies: "service_map",
			traces_duration_stats: "find_slow_traces",
			errors_summary: "find_errors",
			span_attribute_keys: "explore_attributes",
			span_attribute_values: "explore_attributes",
			resource_attribute_keys: "explore_attributes",
			resource_attribute_values: "explore_attributes",
			metric_attribute_keys: "explore_attributes",
			services_facets: "explore_attributes",
		}

		const queryWarehouse = Effect.fn("MapleClient.queryWarehouse")(function* <T = unknown>(
			queryName: WarehouseQueryName,
			params?: Record<string, unknown>,
		) {
			// Map the warehouse query name to the MCP tool that wraps it. A missing
			// mapping is a typed failure, raised before crossing the fetch boundary.
			const toolName = PIPE_TO_TOOL[queryName]
			if (!toolName) {
				return yield* new MapleApiError({
					message: `No MCP tool mapping for query: ${queryName}`,
					queryName,
				})
			}

			const sid = yield* ensureSession
			const id = yield* nextId
			const args = mapParamsToToolArgs(queryName, params ?? {})

			const result = yield* Effect.tryPromise({
				try: () =>
					fetch(mcpUrl, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
							"mcp-session-id": sid,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id,
							method: "tools/call",
							params: { name: toolName, arguments: args },
						}),
					}).then(async (resp) => {
						if (!resp.ok) {
							const text = await resp.text()
							return { __httpError: `HTTP ${resp.status}: ${text}` } as const
						}
						return (await resp.json()) as Record<string, unknown>
					}),
				catch: (error) =>
					new MapleApiError({
						message: `Query ${queryName} failed: ${error instanceof Error ? error.message : String(error)}`,
						queryName,
					}),
			})

			if ("__httpError" in result) {
				return yield* new MapleApiError({
					message: `Query ${queryName} failed: ${result.__httpError}`,
					queryName,
				})
			}

			const res = result as Record<string, any>
			if (res.error) {
				return yield* new MapleApiError({
					message: `MCP error: ${JSON.stringify(res.error)}`,
					queryName,
				})
			}

			// Parse structured data from dual content (second text item has __maple_ui marker)
			const content = res.result?.content ?? []
			for (const c of content) {
				if (c.type === "text" && c.text?.includes("__maple_ui")) {
					try {
						const parsed = JSON.parse(c.text)
						return { data: extractDataArray(queryName, parsed) as T[] }
					} catch {
						// fall through
					}
				}
			}

			return { data: [] as T[] }
		})

		const queryEngine = Effect.fn("MapleClient.queryEngine")(function* (request: {
			startTime: string
			endTime: string
			query: unknown
		}) {
			const q = request.query as any
			const result = yield* callTool("query_data", {
				source: q.source,
				kind: q.kind,
				metric: q.metric,
				group_by: q.groupBy?.[0] ?? q.groupBy,
				start_time: request.startTime,
				end_time: request.endTime,
				service_name: q.filters?.serviceName,
				span_name: q.filters?.spanName,
				limit: q.limit,
				bucket_seconds: q.bucketSeconds,
				...(q.filters?.attributeFilters?.[0] && {
					attribute_key: q.filters.attributeFilters[0].key,
					attribute_value: q.filters.attributeFilters[0].value,
				}),
			})
			if (result._raw) {
				return { result: { kind: q.kind, source: q.source, data: [] } }
			}
			return { result: { kind: q.kind, source: q.source, data: result.data ?? result } }
		})

		// NOTE: returned as a bare object (typed by MapleClientShape) rather than
		// MapleClient.of(...) — calling the static `.of` inside an inline `make`
		// creates a self-reference cycle in the class's own base expression
		// (TS2506). The shape is still fully checked against MapleClientShape.
		const shape: MapleClientShape = { queryWarehouse, callTool, queryEngine }
		return shape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

function mapParamsToToolArgs(pipe: string, params: Record<string, unknown>): Record<string, unknown> {
	// Map tinybird pipe params to MCP tool arguments
	switch (pipe) {
		case "service_overview":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				environment: params.environments,
			}
		case "errors_by_type":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				service: params.services,
				environment: params.deployment_envs,
				limit: params.limit,
			}
		case "list_traces":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				service: params.any_service ?? params.service,
				span_name: params.any_span_name ?? params.span_name,
				has_error: params.has_error,
				min_duration_ms: params.min_duration_ms,
				max_duration_ms: params.max_duration_ms,
				http_method: params.http_method,
				trace_id: params.trace_id,
				attribute_key: params.attribute_filter_key,
				attribute_value: params.attribute_filter_value,
				root_only: params.service ? true : false,
				offset: params.offset,
				limit: params.limit,
			}
		case "span_hierarchy":
			return { trace_id: params.trace_id }
		case "list_logs":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				service: params.service,
				severity: params.severity,
				search: params.body_search,
				trace_id: params.trace_id,
				offset: params.offset,
				limit: params.limit,
			}
		case "error_detail_traces":
			return {
				error_type: params.error_type,
				start_time: params.start_time,
				end_time: params.end_time,
				service: params.services,
				limit: params.limit,
			}
		case "service_dependencies":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				service_name: params.service_name,
				environment: params.deployment_env,
			}
		case "traces_duration_stats":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				service: params.service,
			}
		case "errors_summary":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				service: params.services,
				environment: params.environments,
			}
		case "span_attribute_keys":
			return {
				source: "traces",
				scope: "span",
				start_time: params.start_time,
				end_time: params.end_time,
				service_name: params.service_name,
				limit: params.limit,
			}
		case "resource_attribute_keys":
			return {
				source: "traces",
				scope: "resource",
				start_time: params.start_time,
				end_time: params.end_time,
				service_name: params.service_name,
				limit: params.limit,
			}
		case "span_attribute_values":
			return {
				source: "traces",
				scope: "span",
				key: params.attribute_key,
				start_time: params.start_time,
				end_time: params.end_time,
				service_name: params.service_name,
				limit: params.limit,
			}
		case "resource_attribute_values":
			return {
				source: "traces",
				scope: "resource",
				key: params.attribute_key,
				start_time: params.start_time,
				end_time: params.end_time,
				service_name: params.service_name,
				limit: params.limit,
			}
		case "metric_attribute_keys":
			return {
				source: "metrics",
				start_time: params.start_time,
				end_time: params.end_time,
				limit: params.limit,
			}
		case "services_facets":
			return { source: "services", start_time: params.start_time, end_time: params.end_time }
		case "logs_count":
			return {
				start_time: params.start_time,
				end_time: params.end_time,
				service: params.service,
				severity: params.severity,
				search: params.body_search,
				trace_id: params.trace_id,
			}
		default:
			return params
	}
}

function extractDataArray(pipe: string, parsed: any): any[] {
	// The structured output has { __maple_ui, tool, data: { ... } }
	const data = parsed.data ?? parsed

	switch (pipe) {
		case "service_overview":
			return data.services ?? []
		case "errors_by_type":
			return data.errors ?? []
		case "list_traces":
			return data.traces ?? []
		case "error_detail_traces":
			return data.traces ?? []
		case "service_dependencies":
			return data.edges ?? []
		case "errors_summary":
			return [data]
		case "span_hierarchy":
			return data.spans ?? []
		case "list_logs":
			return data.logs ?? []
		case "logs_count":
			return [{ count: data.total ?? 0 }]
		case "traces_duration_stats":
			return data.stats ? [data.stats] : [data]
		default:
			if (Array.isArray(data)) return data
			if (data.keys) return data.keys
			if (data.values) return data.values
			return [data]
	}
}
