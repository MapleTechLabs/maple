/**
 * Idle TTLs for the reads that go through `ReadCache`.
 */
export const IdleTtl = {
	spanHierarchy: 60_000,
	traceSpanEvents: 60_000,
	logsCount: 60_000,
	productEventsForTrace: 60_000,
	replaysForTrace: 60_000,
	tracesFacets: 30_000,
	serviceOverview: 30_000,
	serviceSparklines: 30_000,
	listReplays: 30_000,
	replaysFacets: 30_000,
	/** `/users`: the directory list. */
	listUsers: 30_000,
	/** `/users?groupBy=group`: the directory grouped. */
	listUserGroups: 30_000,
	/** `/users`: the rail facets and summary. */
	usersFacets: 30_000,
	/** `/users/$userId`: the profile, stats, rail, sessions, events, MCP sessions and timeline. */
	userOverview: 30_000,
	/** `/users/$userId`: the Traces tab's requests. */
	userTraces: 30_000,
	/** `/users/$userId`: the Logs tab's lines. */
	userLogs: 30_000,
	replay: 60_000,
	replayManifest: 240_000,
	sessionTranscript: 60_000,
	/** The infra timeseries reads (host, pod, node, container). */
	infraTimeseries: 30_000,
	servicesFacets: 300_000,
	releases: 30_000,
	releaseDetail: 30_000,
	/** Commit details. */
	commitDetail: 300_000,
	/** `GET /v2/telemetry_signals`: shared by every page's empty state. */
	signalPresence: 60_000,
	/** Retained queries, such as the open anomaly counts. */
	retainedQuery: 60_000,
} as const
