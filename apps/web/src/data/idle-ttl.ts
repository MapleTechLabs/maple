/**
 * Idle TTLs for the reads that go through `ReadCache`.
 */
export const IdleTtl = {
	/** `getSpanHierarchyResultAtom`. */
	spanHierarchy: 60_000,
	/** `getTraceSpanEventsResultAtom`. */
	traceSpanEvents: 60_000,
	/** `getLogsCountResultAtom`. */
	logsCount: 60_000,
	/** `productEventsForTraceResultAtom`. */
	productEventsForTrace: 60_000,
	/** `getReplaysForTraceResultAtom`. */
	replaysForTrace: 60_000,
	/** `getTracesFacetsResultAtom`. */
	tracesFacets: 30_000,
	/** `getServiceOverviewResultAtom`. */
	serviceOverview: 30_000,
	/** `getCustomChartServiceSparklinesResultAtom`. */
	serviceSparklines: 30_000,
	/** `listReplaysResultAtom`. */
	listReplays: 30_000,
	/** `replaysFacetsResultAtom`. */
	replaysFacets: 30_000,
	/** `getReplayResultAtom`. */
	replay: 60_000,
	/** `getReplayManifestResultAtom`. */
	replayManifest: 240_000,
	/** `getSessionTranscriptResultAtom`. */
	sessionTranscript: 60_000,
	/** The `*InfraTimeseriesResultAtom` families (host, pod, node, container). */
	infraTimeseries: 30_000,
	/** `getServicesFacetsResultAtom`. */
	servicesFacets: 300_000,
	/** `getReleasesResultAtom`. */
	releases: 30_000,
	/** `getReleaseDetailResultAtom`. */
	releaseDetail: 30_000,
	/** `COMMIT_DETAIL_TTL_MS` (`commitQueryAtom`, `commitsQueryAtom`). */
	commitDetail: 300_000,
	/** `GET /v2/telemetry_signals`: shared by every page's empty state. */
	signalPresence: 60_000,
	/** `DEFAULT_QUERY_TTL` (`retainedQueryV2`): `openAnomalyServiceCountsAtom`. */
	retainedQuery: 60_000,
} as const
