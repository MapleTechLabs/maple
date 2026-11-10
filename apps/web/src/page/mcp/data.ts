import type {
	McpCallItem,
	McpClientItem,
	McpClientKind,
	McpErrorGroupItem,
	McpMethodItem,
	McpServerItem,
	McpToolItem,
} from "@maple/domain/http"
import type { ToolSeriesPoint } from "../kit/tools/model"

// What the MCP hub reads, per server and per tool. Every field comes from the MCP semantic
// conventions (`mcp.method.name`, `gen_ai.tool.name`, `error.type`, `user_agent.original`).

export type { McpClientKind }

export type McpServerRow = McpServerItem

export type McpToolRow = McpToolItem

export type McpClientRow = McpClientItem

export type McpMethodRow = typeof McpMethodItem.Type

export type McpFailureKind = Readonly<{
	label: string
	codes: ReadonlyArray<string>
	detail: string
	count: number
}>

export type McpCoverageRow = Readonly<{
	isPresent: boolean
	label: string
	attributes: ReadonlyArray<string>
	detail: string
}>

export type McpServerOverview = Readonly<{
	service: string
	protocolVersion: string
	transport: string
	firstSpanMs: number
	nowMs: number
	series: ReadonlyArray<ToolSeriesPoint>
	clientSeries: ReadonlyArray<ToolSeriesPoint>
	totals: Readonly<{
		calls: number
		errors: number
		statusErrors: number
		p50: number
		p90: number
		p95: number
	}>
	tools: ReadonlyArray<McpToolRow>
	clients: ReadonlyArray<McpClientRow>
	clientInfo: ReadonlyArray<Readonly<{ name: string; count: number; connects: number }>>
	clientInfoUnit: "connect" | "request"
	failures: ReadonlyArray<McpFailureKind>
	methods: ReadonlyArray<McpMethodRow>
	coverage: ReadonlyArray<McpCoverageRow>
}>

/** One call in the Calls table; the table never reads the span id. */
export type McpCallRow = Omit<McpCallItem, "spanId">

export type McpErrorGroup = McpErrorGroupItem

export type McpToolDetail = Readonly<{
	tool: string
	calls: number
	errors: number
	clients: number
	firstCallMs: number
	lastCallMs: number
	series: ReadonlyArray<ToolSeriesPoint>
	clientSeries: ReadonlyArray<ToolSeriesPoint>
	errorGroups: ReadonlyArray<McpErrorGroup>
	/** The Calls table's three lists: the slowest calls, the failed ones, the latest. */
	slowest: ReadonlyArray<McpCallRow>
	failed: ReadonlyArray<McpCallRow>
	recent: ReadonlyArray<McpCallRow>
}>
