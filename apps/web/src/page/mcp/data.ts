import type { ToolSeriesPoint } from "../agent-sessions/tools-kit/model"

// What the MCP hub reads, per server and per tool. Every field comes from the MCP semantic
// conventions (`mcp.method.name`, `gen_ai.tool.name`, `error.type`, `user_agent.original`).

export type McpClientKind = "agent" | "script" | "unknown"

export type McpServerRow = Readonly<{
	service: string
	protocolVersion: string
	calls: number
	errors: number
	p95: number
	tools: number
	topClient: string
	topClientShare: number
	lastCallMs: number
	spark: ReadonlyArray<number>
}>

export type McpToolRow = Readonly<{
	tool: string
	calls: number
	errors: number
	p50: number
	p90: number
	p95: number
	topError: string | null
	lastCallMs: number
	spark: ReadonlyArray<number>
}>

export type McpClientRow = Readonly<{ name: string; kind: McpClientKind; calls: number; errors: number }>

export type McpMethodRow = Readonly<{ method: string; calls: number; p50: number; p95: number }>

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
	initializers: ReadonlyArray<Readonly<{ name: string; count: number }>>
	failures: ReadonlyArray<McpFailureKind>
	methods: ReadonlyArray<McpMethodRow>
	coverage: ReadonlyArray<McpCoverageRow>
}>

export type McpCallRow = Readonly<{
	timeMs: number
	client: string
	requestId: string
	durationNs: number
	errorType: string | null
	traceId: string
}>

export type McpErrorGroup = Readonly<{
	errorType: string
	message: string | null
	count: number
	clients: number
	lastSeenMs: number
	trend: ReadonlyArray<number>
}>

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
