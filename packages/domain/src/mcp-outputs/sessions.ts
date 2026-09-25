/**
 * Output schemas for the sessions MCP tools: browser session replays, product events and
 * funnels, and AI agent sessions with their tool analytics.
 */
import { Schema } from "effect"
import { FunnelKeyBy, FunnelStep } from "@maple/query-model"
import {
	AiSessionListItem,
	AiToolErrorBreakdownItem,
	AiToolErrorItem,
	AiToolErrorOccurrence,
	AiToolErrorSessionItem,
	AiToolErrorVariantItem,
	AiToolsAggregate,
	AiToolsBreakdownItem,
	AI_SESSION_SORT_KEYS,
} from "../http/ai-sessions"
import { OutputPagination, OutputTimeRange } from "./shared"

const StringList = Schema.Array(Schema.String)

/* Browser session replays */

export const SessionSearchRow = Schema.Struct({
	sessionId: Schema.String,
	/** The session's end-user id, or "" for an anonymous session. */
	userId: Schema.String,
	/** identify() identity; "" when the session was never identified. */
	userName: Schema.String,
	userEmail: Schema.String,
	groupId: Schema.String,
	groupName: Schema.String,
	startTime: Schema.String,
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	browserName: Schema.String,
	osName: Schema.String,
	deviceType: Schema.String,
	country: Schema.String,
	serviceName: Schema.String,
	pageViews: Schema.Number,
	clickCount: Schema.Number,
	errorCount: Schema.Number,
	traceCount: Schema.Number,
	urlInitial: Schema.String,
	/** In-session events matching the event predicates; present only when one was applied. */
	matchCount: Schema.optionalKey(Schema.Number),
})

/** The filters a search_sessions call applied, echoed so a next page repeats them. */
export const SearchSessionsFilters = Schema.Struct({
	userId: Schema.optionalKey(Schema.String),
	userSearch: Schema.optionalKey(Schema.String),
	groupName: Schema.optionalKey(Schema.String),
	service: Schema.optionalKey(Schema.String),
	browser: Schema.optionalKey(Schema.String),
	country: Schema.optionalKey(Schema.String),
	deviceType: Schema.optionalKey(Schema.String),
	hasErrors: Schema.optionalKey(Schema.Boolean),
	durationMinMs: Schema.optionalKey(Schema.Number),
	durationMaxMs: Schema.optionalKey(Schema.Number),
	activeMinMs: Schema.optionalKey(Schema.Number),
	activeMaxMs: Schema.optionalKey(Schema.Number),
	eventType: Schema.optionalKey(Schema.String),
	level: Schema.optionalKey(Schema.String),
	httpStatusMin: Schema.optionalKey(Schema.Number),
	urlContains: Schema.optionalKey(Schema.String),
	messageContains: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
})

export const SearchSessionsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	sessions: Schema.Array(SessionSearchRow),
	pagination: OutputPagination,
	filters: SearchSessionsFilters,
	/** Whether an in-session event predicate narrowed the list (rows then carry `matchCount`). */
	eventFiltered: Schema.Boolean,
})

export const SessionTranscriptEvent = Schema.Struct({
	timestamp: Schema.String,
	type: Schema.String,
	url: Schema.String,
	traceId: Schema.String,
	level: Schema.String,
	message: Schema.String,
	targetSelector: Schema.String,
	targetText: Schema.optionalKey(Schema.String),
	netMethod: Schema.String,
	netUrl: Schema.String,
	netStatus: Schema.Number,
	netDurationMs: Schema.Number,
})

export const SessionTranscriptEventType = Schema.Literals([
	"navigation",
	"click",
	"input",
	"console",
	"network",
	"error",
])

export const GetSessionTranscriptOutput = Schema.Struct({
	sessionId: Schema.String,
	events: Schema.Array(SessionTranscriptEvent),
	pagination: OutputPagination,
	filters: Schema.Struct({
		eventTypes: Schema.Array(SessionTranscriptEventType),
		onlyErrors: Schema.Boolean,
		aroundTraceId: Schema.optionalKey(Schema.String),
	}),
})

export const GetSessionTracesOutput = Schema.Struct({
	session: Schema.Struct({
		sessionId: Schema.String,
		startTime: Schema.String,
		endTime: Schema.NullOr(Schema.String),
		durationMs: Schema.NullOr(Schema.Number),
		status: Schema.String,
		userId: Schema.String,
		urlInitial: Schema.String,
		browserName: Schema.String,
		osName: Schema.String,
		deviceType: Schema.String,
		country: Schema.String,
		serviceName: Schema.String,
		pageViews: Schema.Number,
		clickCount: Schema.Number,
		errorCount: Schema.Number,
		/** Engaged time (ms) from session_events gaps; null if no distilled events. */
		activeTimeMs: Schema.NullOr(Schema.Number),
		/** Idle time (ms), the long-gap complement of active time. */
		idleTimeMs: Schema.NullOr(Schema.Number),
	}),
	totalTraceCount: Schema.Number,
	traces: Schema.Array(
		Schema.Struct({
			traceId: Schema.String,
			startTime: Schema.String,
			durationMs: Schema.Number,
			rootSpanName: Schema.String,
			rootServiceName: Schema.String,
			spanCount: Schema.Number,
			hasError: Schema.Boolean,
		}),
	),
})

/* Product events and funnels */

export const QueryFunnelStepRow = Schema.Struct({
	/** 1-based. */
	step: Schema.Number,
	label: Schema.String,
	count: Schema.Number,
	/** Share of step 1, 0-1. */
	ofFirst: Schema.Number,
	/** Conversion from the previous step, 0-1; null on step 1 or when the previous step counted nobody. */
	ofPrevious: Schema.NullOr(Schema.Number),
	dropOff: Schema.Number,
})

export const QueryFunnelOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	keyBy: FunnelKeyBy,
	windowSeconds: Schema.Number,
	steps: Schema.Array(QueryFunnelStepRow),
	/** Last step over first, 0-1; null with fewer than two steps or an empty first step. */
	conversion: Schema.NullOr(Schema.Number),
	breakdown: Schema.optionalKey(
		Schema.Struct({
			by: Schema.String,
			groups: Schema.Array(
				Schema.Struct({
					group: Schema.String,
					counts: Schema.Array(Schema.Number),
					conversion: Schema.NullOr(Schema.Number),
				}),
			),
		}),
	),
	/** The steps as given, so a follow-up call can repeat the funnel. */
	definition: Schema.Array(FunnelStep),
})

export const ProductEventKind = Schema.Literals(["custom", "navigation", "screen"])

export const ListProductEventsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	events: Schema.Array(
		Schema.Struct({
			eventName: Schema.String,
			/** `navigation` (page view), `custom` (`track()`), `screen` (mobile). */
			kind: Schema.String,
			count: Schema.Number,
			sessions: Schema.Number,
			persons: Schema.Number,
		}),
	),
	/** The kind filter, when one applied. */
	kind: Schema.optionalKey(ProductEventKind),
	/** Whether a kind or name filter narrowed the list. */
	narrowed: Schema.Boolean,
})

/* AI agent sessions */

/** The filters a list_agent_sessions call applied, echoed so a next page repeats them. */
export const ListAgentSessionsFilters = Schema.Struct({
	vendors: Schema.optionalKey(StringList),
	services: Schema.optionalKey(StringList),
	environments: Schema.optionalKey(StringList),
	models: Schema.optionalKey(StringList),
	agents: Schema.optionalKey(StringList),
	tools: Schema.optionalKey(StringList),
	search: Schema.optionalKey(Schema.String),
	hasErrors: Schema.optionalKey(Schema.Boolean),
	excludeTraceSessions: Schema.optionalKey(Schema.Boolean),
	durationMinMs: Schema.optionalKey(Schema.Number),
	durationMaxMs: Schema.optionalKey(Schema.Number),
	costMin: Schema.optionalKey(Schema.Number),
	costMax: Schema.optionalKey(Schema.Number),
	tokensMin: Schema.optionalKey(Schema.Number),
	tokensMax: Schema.optionalKey(Schema.Number),
	llmCallsMin: Schema.optionalKey(Schema.Number),
	llmCallsMax: Schema.optionalKey(Schema.Number),
	toolCallsMin: Schema.optionalKey(Schema.Number),
	toolCallsMax: Schema.optionalKey(Schema.Number),
	sortBy: Schema.Literals(AI_SESSION_SORT_KEYS),
	sortDir: Schema.Literals(["asc", "desc"]),
})

export const ListAgentSessionsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	/** Every figure is over the session's AGENT spans; the app's own spans are not counted. */
	sessions: Schema.Array(AiSessionListItem),
	pagination: OutputPagination,
	filters: ListAgentSessionsFilters,
})

const AgentSessionTokens = Schema.Struct({
	input: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
	output: Schema.Number,
	reasoning: Schema.Number,
	total: Schema.Number,
})

const CheckStatus = Schema.Literals(["failed", "warning", "passed", "skipped"])

export const GetAgentSessionOutput = Schema.Struct({
	sessionId: Schema.String,
	/** The bounds the spans were read under, as warehouse datetime literals. */
	window: Schema.optionalKey(OutputTimeRange),
	/** How much of the session was read. `cap` and `too_large` mean only its beginning was. */
	load: Schema.Struct({
		spans: Schema.Number,
		truncated: Schema.Literals(["none", "cap", "too_large"]),
		/** For `too_large`: the start_time a next call resumes from. */
		resumeStartTime: Schema.optionalKey(Schema.String),
	}),
	vendorIds: StringList,
	agentNames: StringList,
	serviceNames: StringList,
	/** The opening user message, when content was captured. */
	title: Schema.optionalKey(Schema.String),
	verdict: Schema.Struct({
		status: Schema.Literals(["failed", "attention", "clean"]),
		/** What follows the verdict word: `the final turn died on ...`, `with 2 warnings`. */
		headline: Schema.String,
		spanId: Schema.optionalKey(Schema.String),
	}),
	checkCounts: Schema.Struct({
		failed: Schema.Number,
		warning: Schema.Number,
		passed: Schema.Number,
		skipped: Schema.Number,
	}),
	checks: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			status: CheckStatus,
			headline: Schema.String,
			action: Schema.optionalKey(Schema.String),
			fixArea: Schema.optionalKey(Schema.String),
		}),
	),
	findingCount: Schema.Number,
	/** The first findings: failures first, the terminal one leading, then anomalies. */
	findings: Schema.Array(
		Schema.Struct({
			kind: Schema.String,
			severity: Schema.Literals(["failure", "anomaly"]),
			label: Schema.String,
			count: Schema.Number,
			turnText: Schema.String,
			detail: Schema.optionalKey(Schema.String),
			spanId: Schema.String,
		}),
	),
	vitals: Schema.Struct({
		wallClockMs: Schema.Number,
		activeMs: Schema.Number,
		idleMs: Schema.Number,
		idleGapCount: Schema.Number,
		agentTimeMs: Schema.Number,
		agentTimeSegments: Schema.Array(
			Schema.Struct({ kind: Schema.Literals(["ttft", "inference", "tool"]), ms: Schema.Number }),
		),
	}),
	work: Schema.Struct({
		turns: Schema.Number,
		llmCalls: Schema.Number,
		toolCalls: Schema.Number,
		spans: Schema.Number,
		traces: Schema.Number,
	}),
	tokens: AgentSessionTokens,
	tokenReporting: Schema.Literals(["per-call", "roll-up", "session-level", "none"]),
	/** USD as the instrumentation reported it; absent when nothing reported a cost. */
	cost: Schema.optionalKey(Schema.Number),
	models: Schema.Array(
		Schema.Struct({
			model: Schema.String,
			llmCalls: Schema.Number,
			totalTokens: Schema.Number,
			cost: Schema.optionalKey(Schema.Number),
		}),
	),
	toolCount: Schema.Number,
	/** The busiest tools. */
	tools: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			calls: Schema.Number,
			failed: Schema.Number,
			totalMs: Schema.Number,
			slowestMs: Schema.Number,
		}),
	),
	failureGroups: Schema.Array(
		Schema.Struct({ kind: Schema.String, label: Schema.String, count: Schema.Number }),
	),
	turnCount: Schema.Number,
	/** The first turns, in start order. */
	turns: Schema.Array(
		Schema.Struct({
			/** `Turn 3`, or `Segment 3` for a trace-anchored turn. */
			ordinal: Schema.String,
			anchorKind: Schema.Literals(["conversation", "agent-root", "trace"]),
			agentName: Schema.optionalKey(Schema.String),
			/** From the session's first span. */
			offsetMs: Schema.Number,
			durationMs: Schema.Number,
			spanCount: Schema.Number,
			failed: Schema.Boolean,
			/** The turn's newest user message, when captured. */
			label: Schema.optionalKey(Schema.String),
		}),
	),
	/** The span behind the verdict (or the first finding), to open with inspect_span. */
	evidence: Schema.optionalKey(
		Schema.Struct({ traceId: Schema.String, spanId: Schema.String, timestamp: Schema.String }),
	),
})

/** What a tool-analytics read was narrowed to. `tool` absent means every tool. */
export const AgentToolSelection = Schema.Struct({
	tool: Schema.optionalKey(Schema.String),
	model: Schema.optionalKey(Schema.String),
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
	toolContains: Schema.optionalKey(Schema.String),
})

export const AgentToolErrorGroupRow = Schema.Struct({
	...AiToolErrorItem.fields,
	/** Failed calls per `bucketSeconds`, oldest first, gaps as zeros. */
	trend: Schema.Array(Schema.Number),
})

export const GetAgentToolsOverviewOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	selection: AgentToolSelection,
	/** The selected tool's `gen_ai.tool.description`. */
	description: Schema.optionalKey(Schema.String),
	/** First and last matched call; "" where nothing matched. */
	firstSeen: Schema.String,
	lastSeen: Schema.String,
	current: AiToolsAggregate,
	/** The equal-length window before this one. */
	previous: Schema.optionalKey(AiToolsAggregate),
	/** Every agent session in the window, before the selection. */
	allSessions: Schema.optionalKey(Schema.Number),
	/** Every tool in the window, busiest first; ignores a selected `tool`. */
	tools: Schema.Array(AiToolsBreakdownItem),
	/** Only when a tool is selected: its failure groups, most failed calls first. */
	failureGroups: Schema.optionalKey(
		Schema.Struct({
			tool: Schema.String,
			bucketSeconds: Schema.Number,
			/** The most groups one read returns. */
			cap: Schema.Number,
			groups: Schema.Array(AgentToolErrorGroupRow),
		}),
	),
})

export const GetAgentToolErrorOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	tool: Schema.String,
	fingerprint: Schema.String,
	selection: AgentToolSelection,
	/** The session the samples were narrowed to. */
	samplesSession: Schema.optionalKey(Schema.String),
	/** Characters kept of each argument/result payload. */
	payloadChars: Schema.Number,
	sessions: Schema.Array(AiToolErrorSessionItem),
	sessionsCap: Schema.Number,
	variants: Schema.Array(AiToolErrorVariantItem),
	variantsCap: Schema.Number,
	breakdown: Schema.Array(AiToolErrorBreakdownItem),
	/** Newest first; payloads clipped to `payloadChars`, `*Bytes` the true size. */
	samples: Schema.Array(AiToolErrorOccurrence),
	hasMoreSamples: Schema.Boolean,
})
