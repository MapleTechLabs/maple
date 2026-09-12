import { createDualContent } from "@/mcp/lib/structured-output"

/**
 * Structured payloads of the three AI agent tool-analytics tools.
 *
 * They live here rather than in `@maple/domain`'s `mcp-structured-types.ts`
 * because that file and the tool registry are wired in one step, after these
 * tools land: {@link agentToolsContent} is the single place the widening lives,
 * and moving these interfaces into the domain union is what removes it.
 */

export interface AgentToolSelectionData {
	tool?: string
	model?: string
	service?: string
	environment?: string
	search?: string
	failingOnly?: boolean
}

/** Durations are milliseconds here; the wire carries nanoseconds. */
export interface AgentToolAggregateData {
	calls: number
	sessions: number
	errors: number
	p50Ms: number
	p90Ms: number
	p95Ms: number
}

export interface AgentToolBreakdownRowData {
	tool: string
	calls: number
	sessions: number
	errors: number
	p50Ms: number
	p95Ms: number
	firstSeen: string
	lastSeen: string
}

export interface AgentToolSeriesPointData {
	bucket: string
	seriesKey: string
	calls: number
	errors: number
	p95Ms: number
}

export interface GetAgentToolsOverviewData {
	timeRange: { start: string; end: string }
	selection: AgentToolSelectionData
	current: AgentToolAggregateData
	/** The equal window ending where this one begins — the deltas' baseline. */
	previous?: AgentToolAggregateData
	/** Sessions of the window before the selection — the share's denominator. */
	allSessions?: number
	firstSeen: string
	lastSeen: string
	description?: string
	breakdown: AgentToolBreakdownRowData[]
	series?: {
		seriesKind: string
		bucketSeconds: number
		/** True where points past the rendered cap were dropped. */
		truncated: boolean
		points: AgentToolSeriesPointData[]
	}
}

export interface AgentToolErrorGroupData {
	fingerprint: string
	errorType: string
	message: string
	calls: number
	sessions: number
	variants: number
	firstSeen: string
	lastSeen: string
	callsSince: number
	/** Failed calls per bucket, oldest first, gaps filled with zero. */
	trend: number[]
}

export interface ListAgentToolErrorsData {
	timeRange: { start: string; end: string }
	selection: AgentToolSelectionData
	bucketSeconds: number
	groups: AgentToolErrorGroupData[]
}

export interface AgentToolErrorSampleData {
	timestamp: string
	traceId: string
	spanId: string
	sessionId: string
	vendorId: string
	agentName: string
	model: string
	service: string
	errorType: string
	message: string
	durationMs: number
	statusCode: string
	/** Clipped to the caller's `payload_chars`; `*Bytes` is the true size. */
	arguments: string
	argumentsBytes: number
	result: string
	resultBytes: number
}

export interface GetAgentToolErrorData {
	timeRange: { start: string; end: string }
	selection: AgentToolSelectionData
	fingerprint: string
	sessions: Array<{
		sessionId: string
		vendorId: string
		agentName: string
		service: string
		hits: number
		lastSeen: string
	}>
	variants: Array<{ message: string; calls: number; lastSeen: string }>
	breakdown: Array<{ model: string; service: string; calls: number }>
	samples: AgentToolErrorSampleData[]
	/** True where the group has samples past this page. */
	hasMoreSamples: boolean
}

export type AgentToolsStructuredOutput =
	| { tool: "get_agent_tools_overview"; data: GetAgentToolsOverviewData }
	| { tool: "list_agent_tool_errors"; data: ListAgentToolErrorsData }
	| { tool: "get_agent_tool_error"; data: GetAgentToolErrorData }

/** `createDualContent` typed against the variants above until they are part of
 *  `StructuredToolOutput`. */
export const agentToolsContent = (markdown: string, output: AgentToolsStructuredOutput) =>
	// SAFETY: the three variants above are not members of `StructuredToolOutput`
	// yet — the registry wiring step adds them verbatim and drops this assertion.
	// Nothing between here and the wire reads the payload structurally.
	createDualContent(markdown, output as never)
