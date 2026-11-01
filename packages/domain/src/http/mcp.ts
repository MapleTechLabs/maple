import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { MCP_CLIENT_KINDS } from "../mcp-clients"
import { TinybirdDateTime } from "../query-engine"
import { BucketSeconds } from "./query-engine"
import { SessionAuthorization } from "./current-tenant"
import { warehouseReadHttpErrors } from "./warehouse"

// MCP hub endpoint schemas (`/mcp-servers`, a server's overview and its tool page).
//
// Backed by MCP server spans that follow the OpenTelemetry MCP conventions
// (`docs/mcp-hub-plan.md`), read raw from `traces` by `ch/queries/mcp.ts`.
// Durations are nanoseconds, times and buckets epoch milliseconds.

const selectionText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

/** Who called: an agent, a script or HTTP library, one of the org's own services, or unrecognised. */
export const McpClientKind = Schema.Literals(MCP_CLIENT_KINDS)
export type McpClientKind = typeof McpClientKind.Type

const windowFields = {
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: BucketSeconds,
}

/** The toolbar's selection. `client` is a client family name as `clients` reports it. */
const selectionFields = {
	client: Schema.optionalKey(selectionText),
	kind: Schema.optionalKey(McpClientKind),
}

const measures = {
	calls: Schema.Number,
	errors: Schema.Number,
	p50: Schema.Number,
	p90: Schema.Number,
	p95: Schema.Number,
}

export const McpSeriesPoint = Schema.Struct({
	bucket: Schema.Number,
	/** `all` for a merged series, else the tool or client family it measures. */
	seriesKey: Schema.String,
	...measures,
})
export type McpSeriesPoint = typeof McpSeriesPoint.Type

export const McpClientItem = Schema.Struct({
	name: Schema.String,
	kind: McpClientKind,
	calls: Schema.Number,
	errors: Schema.Number,
	/** `initialize` requests: connections, which a client can open many of without calling a tool. */
	connects: Schema.Number,
	/** Distinct `client.address` values across its MCP requests. */
	sources: Schema.Number,
	/** Its latest MCP request of any method; `0` when unknown. */
	lastSeenMs: Schema.Number,
})
export type McpClientItem = typeof McpClientItem.Type

// ---------------------------------------------------------------------------
// /mcp
// ---------------------------------------------------------------------------

export class McpServersRequest extends Schema.Class<McpServersRequest>("McpServersRequest")({
	...windowFields,
}) {}

export const McpServerItem = Schema.Struct({
	service: Schema.String,
	protocolVersion: Schema.String,
	calls: Schema.Number,
	errors: Schema.Number,
	p95: Schema.Number,
	tools: Schema.Number,
	topClient: Schema.String,
	topClientShare: Schema.Number,
	lastCallMs: Schema.Number,
	/** Calls per bucket over the whole window, zeros included. */
	spark: Schema.Array(Schema.Number),
})
export type McpServerItem = typeof McpServerItem.Type

export class McpServersResponse extends Schema.Class<McpServersResponse>("McpServersResponse")({
	servers: Schema.Array(McpServerItem),
}) {}

// ---------------------------------------------------------------------------
// /mcp/:service
// ---------------------------------------------------------------------------

export class McpOverviewRequest extends Schema.Class<McpOverviewRequest>("McpOverviewRequest")({
	service: selectionText,
	...windowFields,
	...selectionFields,
	/** Case-insensitive tool-name substring. */
	search: Schema.optionalKey(selectionText),
	failingOnly: Schema.optionalKey(Schema.Boolean),
}) {}

export const McpToolItem = Schema.Struct({
	tool: Schema.String,
	...measures,
	topError: Schema.NullOr(Schema.String),
	lastCallMs: Schema.Number,
	spark: Schema.Array(Schema.Number),
})
export type McpToolItem = typeof McpToolItem.Type

export const McpMethodItem = Schema.Struct({
	method: Schema.String,
	calls: Schema.Number,
	p50: Schema.Number,
	p95: Schema.Number,
})

/** Raw counts behind the data-coverage checklist; the page words them. */
export const McpCoverage = Schema.Struct({
	toolCalls: Schema.Number,
	withToolName: Schema.Number,
	withUserAgent: Schema.Number,
	toolErrors: Schema.Number,
	/** Failed calls carrying a status message, the only "why" a span can give. */
	errorsWithMessage: Schema.Number,
	withSession: Schema.Number,
	withCallerTrace: Schema.Number,
	protocolVersion: Schema.String,
	transport: Schema.String,
})
export type McpCoverage = typeof McpCoverage.Type

export class McpOverviewResponse extends Schema.Class<McpOverviewResponse>("McpOverviewResponse")({
	service: Schema.String,
	protocolVersion: Schema.String,
	transport: Schema.String,
	/** The service's first MCP tool call on record (hour precision before the window); `0` when none. */
	firstSpanMs: Schema.Number,
	/** Tools called in the window before the selection narrows it. */
	toolCount: Schema.Number,
	series: Schema.Array(McpSeriesPoint),
	clientSeries: Schema.Array(McpSeriesPoint),
	totals: Schema.Struct({ ...measures, statusErrors: Schema.Number }),
	tools: Schema.Array(McpToolItem),
	/** Clients under the selection. */
	clients: Schema.Array(McpClientItem),
	/** Every client in the window, for the client and kind facets. */
	allClients: Schema.Array(McpClientItem),
	/** `clientInfo.name` from real `initialize` requests. */
	initializers: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number })),
	/** Failed calls per `error.type` under the selection. */
	failures: Schema.Array(Schema.Struct({ errorType: Schema.String, count: Schema.Number })),
	methods: Schema.Array(McpMethodItem),
	coverage: McpCoverage,
}) {}

// ---------------------------------------------------------------------------
// /mcp/:service/tools/:tool
// ---------------------------------------------------------------------------

export class McpToolRequest extends Schema.Class<McpToolRequest>("McpToolRequest")({
	service: selectionText,
	tool: selectionText,
	...windowFields,
	...selectionFields,
	failingOnly: Schema.optionalKey(Schema.Boolean),
}) {}

export const McpCallItem = Schema.Struct({
	timeMs: Schema.Number,
	client: Schema.String,
	requestId: Schema.String,
	durationNs: Schema.Number,
	errorType: Schema.NullOr(Schema.String),
	traceId: Schema.String,
	spanId: Schema.String,
})
export type McpCallItem = typeof McpCallItem.Type

export const McpErrorGroupItem = Schema.Struct({
	errorType: Schema.String,
	message: Schema.NullOr(Schema.String),
	count: Schema.Number,
	clients: Schema.Number,
	lastSeenMs: Schema.Number,
	trend: Schema.Array(Schema.Number),
})
export type McpErrorGroupItem = typeof McpErrorGroupItem.Type

export class McpToolResponse extends Schema.Class<McpToolResponse>("McpToolResponse")({
	tool: Schema.String,
	calls: Schema.Number,
	errors: Schema.Number,
	clients: Schema.Number,
	/** `0` when the tool had no call in the window. */
	firstCallMs: Schema.Number,
	lastCallMs: Schema.Number,
	series: Schema.Array(McpSeriesPoint),
	clientSeries: Schema.Array(McpSeriesPoint),
	allClients: Schema.Array(McpClientItem),
	errorGroups: Schema.Array(McpErrorGroupItem),
	slowest: Schema.Array(McpCallItem),
	failed: Schema.Array(McpCallItem),
	recent: Schema.Array(McpCallItem),
}) {}

export class McpInternalApiGroup extends HttpApiGroup.make("mcpInternal")
	.add(
		HttpApiEndpoint.post("servers", "/servers", {
			payload: McpServersRequest,
			success: McpServersResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("overview", "/overview", {
			payload: McpOverviewRequest,
			success: McpOverviewResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("tool", "/tool", {
			payload: McpToolRequest,
			success: McpToolResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.prefix("/internal/mcp-servers")
	.middleware(SessionAuthorization) {}
