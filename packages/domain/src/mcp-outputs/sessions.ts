import { Schema } from "effect"
import {
	FunnelExclusion,
	FunnelKeyBy,
	FunnelStep,
	PathsAnchor,
	PathsDirection,
	RetentionInterval,
	RetentionKeyBy,
} from "@maple/query-model"
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
import { SessionTag } from "../session-tags"

const StringList = Schema.Array(Schema.String)

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
	/** Rule-based tags: one quality tier plus `signed_in` / `new_visitor` when they apply. */
	tags: Schema.Array(SessionTag),
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
	tags: Schema.optionalKey(Schema.Array(SessionTag)),
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
	/** With `details`, steps 2..N: milliseconds from the previous step's event, median and p90. */
	p50Ms: Schema.optionalKey(Schema.Number),
	p90Ms: Schema.optionalKey(Schema.Number),
	/** With `details`, steps 2..N: milliseconds from step 1's event. */
	sinceStartP50Ms: Schema.optionalKey(Schema.Number),
	sinceStartP90Ms: Schema.optionalKey(Schema.Number),
	/** With `details`, steps 2..N: what the people who stopped before this step did next; `''` is nothing. */
	leavers: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number }))),
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
	/** The exclusions as given, when there were any. */
	exclusions: Schema.optionalKey(Schema.Array(FunnelExclusion)),
	/** The population filters as given, by parameter name, so a follow-up call keeps them. */
	filters: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/** Set when a step's events lack the identity `keyBy` counts by, so the step reads as empty. */
	identityNote: Schema.optionalKey(Schema.String),
	/** The key every step's events do carry, when `identityNote` is set and there is one. */
	suggestedKeyBy: Schema.optionalKey(FunnelKeyBy),
	/** Set when the window reaches past what sessions are kept and the funnel reads them. */
	sessionNote: Schema.optionalKey(Schema.String),
	/** Set when `details` was asked for and could not be read. */
	detailsNote: Schema.optionalKey(Schema.String),
})

export const QueryPathsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	anchor: PathsAnchor,
	direction: PathsDirection,
	depth: Schema.Number,
	keyBy: FunnelKeyBy,
	windowSeconds: Schema.Number,
	/** Everyone who reached the anchor in the window. */
	total: Schema.Number,
	/** Set when a session filter is used and the window starts before sessions are kept. */
	sessionNote: Schema.optionalKey(Schema.String),
	/** The population filters as given, by parameter name, so a follow-up call keeps them. */
	filters: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/** One entry per hop away from the anchor, nearest first. */
	hops: Schema.Array(
		Schema.Struct({
			hop: Schema.Number,
			/** The nodes of this column, most visited first: `''` is "nothing followed", `$other` the folded rest. */
			nodes: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number })),
			/** The hop's transitions, most common first. */
			edges: Schema.Array(
				Schema.Struct({ from: Schema.String, to: Schema.String, count: Schema.Number }),
			),
		}),
	),
})

export const QueryCohortOutput = Schema.Struct({
	/** The user and account property filters as given, by parameter name, so a follow-up call keeps them. */
	filters: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	timeRange: OutputTimeRange,
	keyBy: RetentionKeyBy,
	did: PathsAnchor,
	didNot: Schema.optionalKey(PathsAnchor),
	/** `ever`: never, up to the window's end. `window`: not inside the window. Only with `didNot`. */
	didNotScope: Schema.optionalKey(Schema.Literals(["ever", "window"])),
	/** Everyone who did `did` in the window, whether they also did `didNot` or not. */
	didTotal: Schema.Number,
	/** The cohort's size: those of `didTotal` that did not do `didNot`. */
	total: Schema.Number,
	limit: Schema.Number,
	/** Set when nobody is counted because the events lack the identity `keyBy` counts by. */
	identityNote: Schema.optionalKey(Schema.String),
	/** The key those events do carry, when `identityNote` is set and there is one. */
	suggestedKeyBy: Schema.optionalKey(RetentionKeyBy),
	/** The members listed, the one who did it last first; `total` counts all of them. */
	members: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			firstAt: Schema.String,
			lastAt: Schema.String,
			count: Schema.Number,
		}),
	),
})

export const QueryRetentionOutput = Schema.Struct({
	/** The user and account property filters as given, by parameter name, so a follow-up call keeps them. */
	filters: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/** The cohort window: who first did the start event inside it. */
	timeRange: OutputTimeRange,
	/** Returns were read up to here. */
	returnsThrough: Schema.String,
	keyBy: RetentionKeyBy,
	interval: RetentionInterval,
	periods: Schema.Number,
	firstEver: Schema.Boolean,
	/** What put a key in a cohort and what counted as coming back, as given; absent means any event. */
	start: Schema.optionalKey(PathsAnchor),
	return: Schema.optionalKey(PathsAnchor),
	cohorts: Schema.Array(
		Schema.Struct({
			/** The cohort interval's first day, `YYYY-MM-DD` (UTC). */
			cohort: Schema.String,
			size: Schema.Number,
			/** `returned[n - 1]`: keys of the cohort with a return event in the n-th interval after it. */
			returned: Schema.Array(Schema.Number),
			/** Intervals after the cohort's own that have fully passed; later ones are still open or ahead. */
			completePeriods: Schema.Number,
			/** Intervals after the cohort's own that have started. */
			startedPeriods: Schema.Number,
		}),
	),
	/** Per period, the share of everyone in a cohort old enough to have finished it; null when none is. */
	overall: Schema.Array(Schema.NullOr(Schema.Number)),
	/** Set when there are no cohorts because the start events lack the identity `keyBy` counts by. */
	identityNote: Schema.optionalKey(Schema.String),
	/** The key those events do carry, when `identityNote` is set and there is one. */
	suggestedKeyBy: Schema.optionalKey(RetentionKeyBy),
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
			/** Distinct accounts (`GroupId`) the event fired for; 0 when it carries none. */
			groups: Schema.Number,
		}),
	),
	/** The kind filter, when one applied. */
	kind: Schema.optionalKey(ProductEventKind),
	/** Whether a kind or name filter narrowed the list. */
	narrowed: Schema.Boolean,
})

/** The filters a list_agent_sessions call applied, echoed so a next page repeats them. */
export const ListAgentSessionsFilters = Schema.Struct({
	vendors: Schema.optionalKey(StringList),
	services: Schema.optionalKey(StringList),
	models: Schema.optionalKey(StringList),
	agents: Schema.optionalKey(StringList),
	tools: Schema.optionalKey(StringList),
	search: Schema.optionalKey(Schema.String),
	hasErrors: Schema.optionalKey(Schema.Boolean),
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
	/** The names of the checks that passed; `checks` holds the rest, each with its sentence. */
	passedChecks: StringList,
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
	turnCount: Schema.Number,
	failedTurnCount: Schema.Number,
	/** The span behind the verdict (or the first finding), to open with inspect_span. */
	evidence: Schema.optionalKey(
		Schema.Struct({ traceId: Schema.String, spanId: Schema.String, timestamp: Schema.String }),
	),
})

const TranscriptRowKind = Schema.Literals([
	"turn",
	"user",
	"system",
	"assistant",
	"prompt",
	"tool",
	"lane-open",
	"lane-close",
	"parallel",
	"structure",
	"note",
])

/** One row of an agent session read as a conversation, flattened for the wire. */
export const AgentTranscriptRow = Schema.Struct({
	kind: TranscriptRowKind,
	/** Lanes deep: 0 is the turn's own thread, 1 a sub-agent or concurrent lane under it. */
	depth: Schema.Number,
	/** The 1-based turn the row belongs to. */
	turn: Schema.Number,
	/** From the session's first span. */
	offsetMs: Schema.optionalKey(Schema.Number),
	durationMs: Schema.optionalKey(Schema.Number),
	agentName: Schema.optionalKey(Schema.String),
	/** What was said: a message, a turn's opening prompt, a note. */
	text: Schema.optionalKey(Schema.String),
	/** A model call's facts (`model · 6.4K → 512 tok · stop tool_calls`), a structure row's label. */
	meta: Schema.optionalKey(Schema.String),
	toolName: Schema.optionalKey(Schema.String),
	args: Schema.optionalKey(Schema.String),
	result: Schema.optionalKey(Schema.String),
	failed: Schema.optionalKey(Schema.Boolean),
	/** The span behind the row, for inspect_span. */
	spanId: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
	/** The span's start, ISO: what `inspect_span timestamp` narrows its scan by. */
	timestamp: Schema.optionalKey(Schema.String),
	/** On a failed `turn` row: why its run ended. */
	reason: Schema.optionalKey(Schema.String),
	/** On a `turn` row: its work. */
	llmCalls: Schema.optionalKey(Schema.Number),
	toolCalls: Schema.optionalKey(Schema.Number),
	/** On a `parallel` row: the lanes that ran at once. */
	lanes: Schema.optionalKey(StringList),
})

export const GetAgentSessionTranscriptOutput = Schema.Struct({
	sessionId: Schema.String,
	window: Schema.optionalKey(OutputTimeRange),
	load: Schema.Struct({
		spans: Schema.Number,
		truncated: Schema.Literals(["none", "cap", "too_large"]),
		resumeStartTime: Schema.optionalKey(Schema.String),
	}),
	/** Every turn of the session, the index a `turn` parameter picks from. */
	turns: Schema.Array(
		Schema.Struct({
			turn: Schema.Number,
			anchorKind: Schema.Literals(["conversation", "agent-root", "trace"]),
			agentName: Schema.optionalKey(Schema.String),
			offsetMs: Schema.Number,
			durationMs: Schema.Number,
			failed: Schema.Boolean,
			label: Schema.optionalKey(Schema.String),
			/** Why a failed turn's run ended. */
			stopReason: Schema.optionalKey(Schema.String),
		}),
	),
	selection: Schema.Struct({
		turn: Schema.optionalKey(Schema.Number),
		failedOnly: Schema.optionalKey(Schema.Boolean),
		search: Schema.optionalKey(Schema.String),
		payloadChars: Schema.Number,
	}),
	/** Rows matching the selection, before paging. */
	rowCount: Schema.Number,
	rows: Schema.Array(AgentTranscriptRow),
	pagination: OutputPagination,
	/** The selection's earliest failure in time (a stopped run counts when it stopped), on any page. */
	firstFailure: Schema.optionalKey(
		Schema.Struct({ traceId: Schema.String, spanId: Schema.String, timestamp: Schema.String }),
	),
	/** Model calls that captured their messages, of all model calls read. */
	capture: Schema.Struct({ capturedCalls: Schema.Number, llmCalls: Schema.Number }),
})

/** What a tool-analytics read was narrowed to. `tool` absent means every tool. */
export const AgentToolSelection = Schema.Struct({
	tool: Schema.optionalKey(Schema.String),
	model: Schema.optionalKey(Schema.String),
	service: Schema.optionalKey(Schema.String),
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
	/** Every tool, busiest first; absent when one tool is selected. */
	tools: Schema.optionalKey(Schema.Array(AiToolsBreakdownItem)),
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
