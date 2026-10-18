/**
 * apps/web's idle TTLs for the reads that go through `ReadCache`: the family's `staleTime`
 * (`lib/services/atoms/warehouse-query-atoms.ts`) or the retained query's `timeToLive`.
 */
export const IdleTtl = {
	/** `getSpanHierarchyResultAtom`. */
	spanHierarchy: 60_000,
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
	/** `getServicesFacetsResultAtom`. */
	servicesFacets: 300_000,
	/** `getReleasesResultAtom`. */
	releases: 30_000,
	/** `getReleaseDetailResultAtom`. */
	releaseDetail: 30_000,
	/** `COMMIT_DETAIL_TTL_MS` (`commitQueryAtom`, `commitsQueryAtom`). */
	commitDetail: 300_000,
	/** `DEFAULT_QUERY_TTL` (`retainedQueryV2`): `openAnomalyServiceCountsAtom`. */
	retainedQuery: 60_000,
} as const
