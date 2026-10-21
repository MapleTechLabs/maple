import type { ErrorIssueDocument, IssueKind, WorkflowState } from "@maple/domain/http"
import { ERROR_ISSUE_SEARCH_MAX_LENGTH } from "@maple/domain/http/v2"
import { hubViewOf, type HubSort, type HubView, type SeverityFilter } from "../../../lib/errors/hub-params"
import {
	buildErrorSignals,
	type ErrorSignal,
	indexInvestigationsByIssue,
} from "../../../lib/models/error-signal"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import { DateTime, Option } from "effect"
import { AsyncData } from "foldkit"
import type { TimeWindow } from "../../../data/time-range"
import type { ErrorsSearch } from "../../../route/search"
import { severityRank } from "../kit/severity"
import type { ListQuery, WarehouseFilters } from "./command"
import type { Model } from "./model"

export type Search = typeof ErrorsSearch.Type

/** How many buckets the row sparkline gets. */
export const SPARK_BUCKETS = 32
/** Rows per page. */
export const PAGE_LIMIT = 50
/** How many fingerprints a volume-ranked list considers. */
export const VOLUME_RANK_LIMIT = 100
export const INVESTIGATIONS_LIMIT = 100

export const viewOf = (search: Search): HubView => hubViewOf(search.view)
export const sortOf = (search: Search): HubSort => search.sort ?? "last_seen"
export const severityOf = (search: Search): SeverityFilter => search.severity ?? "all"

/** The sidebar's service and environment narrow the warehouse side too. */
export const warehouseFiltersOf = (search: Search, window: TimeWindow): WarehouseFilters => ({
	startTime: window.startTime,
	endTime: window.endTime,
	services: search.service ? [search.service] : undefined,
	deploymentEnvs: search.env ? [search.env] : undefined,
})

/** `listQuery` (`ErrorsHub`): every param a filter the issues API applies itself. */
export const listQueryOf = (search: Search, rankedHashes: ReadonlyArray<string> | null): ListQuery => {
	const view = viewOf(search)
	const sort = sortOf(search)
	const severity = severityOf(search)
	return {
		limit: PAGE_LIMIT,
		sort: sort === "severity" ? "severity" : "last_seen",
		...(severity !== "all" ? { severity } : undefined),
		...(search.service ? { service_name: search.service } : undefined),
		...(search.env ? { deployment_environment: search.env } : undefined),
		...(search.kind ? { kind: search.kind } : undefined),
		...(search.regressed === true
			? { workflow_state: "regressed" as const }
			: view === "all"
				? undefined
				: { state: view }),
		...(view === "open" ? undefined : { include_archived: "true" as const }),
		...(search.q ? { search: search.q.slice(0, ERROR_ISSUE_SEARCH_MAX_LENGTH) } : undefined),
		...(rankedHashes === null ? undefined : { fingerprint_hash: rankedHashes.join(",") }),
	}
}

// The states each hub view covers, and the signal sort.
const VIEW_STATES = {
	open: ["triage", "regressed", "todo", "in_progress", "in_review"],
	closed: ["verifying", "done", "cancelled", "wontfix"],
	all: "all",
} satisfies Record<HubView, ReadonlyArray<WorkflowState> | "all">

export const viewCovers = (view: HubView, state: WorkflowState): boolean => {
	const states: ReadonlyArray<string> | "all" = VIEW_STATES[view]
	return states === "all" || states.includes(state)
}

export const sortSignals = (
	signals: ReadonlyArray<ErrorSignal>,
	sort: HubSort,
): ReadonlyArray<ErrorSignal> =>
	sort === "volume"
		? signals.toSorted((a, b) => (b.windowCount ?? -1) - (a.windowCount ?? -1))
		: sort === "severity"
			? signals.toSorted((a, b) => {
					const diff = severityRank(a.severity) - severityRank(b.severity)
					return diff !== 0 ? diff : (b.windowCount ?? -1) - (a.windowCount ?? -1)
				})
			: signals.toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))

/** Issues across the loaded pages, first slot wins, narrowed to the view. */
export const uniqueIssues = (
	pages: ReadonlyArray<ReadonlyArray<ErrorIssueDocument>>,
	view: HubView,
): ReadonlyArray<ErrorIssueDocument> => {
	const byId = new Map<string, ErrorIssueDocument>()
	pages.flat().forEach((issue) => {
		if (!byId.has(issue.id)) byId.set(issue.id, issue)
	})
	return [...byId.values()].filter((issue) => viewCovers(view, issue.workflowState))
}

// copied: `KIND_LABEL`, `errorFilterChips` and `hasErrorFilters` (lib/errors/error-filter-chips.ts
// types its input from the route module).
export const KIND_LABEL = {
	error: "Exceptions",
	alert: "Alert rules",
	integration: "Integrations",
} satisfies Record<IssueKind, string>

export type FilterChip = Readonly<{
	param: "service" | "env" | "kind" | "regressed"
	label: string
	values: ReadonlyArray<string>
}>

export const errorFilterChips = (search: Search): ReadonlyArray<FilterChip> => [
	...(search.service ? [{ param: "service" as const, label: "Service", values: [search.service] }] : []),
	...(search.env ? [{ param: "env" as const, label: "Environment", values: [search.env] }] : []),
	...(search.kind ? [{ param: "kind" as const, label: "Source", values: [KIND_LABEL[search.kind]] }] : []),
	...(search.regressed === true
		? [{ param: "regressed" as const, label: "State", values: ["Regressed"] }]
		: []),
]

export const hasErrorFilters = (search: Search): boolean => errorFilterChips(search).length > 0

/** Warehouse `YYYY-MM-DD HH:mm:ss` (UTC) to epoch ms; `null` when it does not parse. */
const warehouseMs = (value: string): number | null =>
	Option.getOrNull(Option.map(DateTime.make(value.replace(" ", "T") + "Z"), DateTime.toEpochMillis))

/** The spark's bucket width: the window over `SPARK_BUCKETS`, at least a minute. */
export const bucketSecondsOf = (window: TimeWindow): number => {
	const startMs = warehouseMs(window.startTime)
	const endMs = warehouseMs(window.endTime)
	if (startMs === null || endMs === null || endMs <= startMs) return 3600
	return Math.max(60, Math.round((endMs - startMs) / 1000 / SPARK_BUCKETS))
}

export const sparkWindowOf = (window: TimeWindow) => ({
	startMs: warehouseMs(window.startTime) ?? 0,
	endMs: warehouseMs(window.endTime) ?? 0,
	bucketMs: bucketSecondsOf(window) * 1000,
})

const dataOr = <A, E>(data: AsyncData.AsyncData<A, E>, fallback: A): A =>
	Option.getOrElse(AsyncData.getData(data), () => fallback)

/** The issues on screen: every loaded page, in order. */
export const issuesOf = (model: Model): ReadonlyArray<ErrorIssueDocument> =>
	uniqueIssues(
		model.pages.map((slot) =>
			dataOr(slot.page.data, { data: [], hasMore: false, nextCursor: null }).data.map(errorIssueFromV2),
		),
		viewOf(model.search),
	)

/** Issues joined with the warehouse volume, the spark series and live investigations, sorted. */
export const signalsOf = (model: Model): ReadonlyArray<ErrorSignal> =>
	sortSignals(
		buildErrorSignals({
			issues: issuesOf(model),
			warehouse: dataOr(model.volume.data, []),
			spark: dataOr(model.spark.data, []),
			investigations: indexInvestigationsByIssue(dataOr(model.investigations.data, [])),
		}),
		sortOf(model.search),
	)

export type ListStatus = "loading" | "failed" | "ready"

/** The volume sort's ranking failed: no list page can be asked until it is retried. */
export const rankingFailed = (model: Model): boolean =>
	sortOf(model.search) === "volume" &&
	(AsyncData.isFailure(model.ranking.data) || AsyncData.isStale(model.ranking.data))

export const listStatusOf = (model: Model): ListStatus => {
	if (rankingFailed(model)) return "failed"
	const first = model.pages[0]
	if (first === undefined) return "loading"
	const data = first.page.data
	if (AsyncData.isFailure(data) || AsyncData.isStale(data)) return "failed"
	return AsyncData.hasData(data) ? "ready" : "loading"
}

/** What a `failed` list failed with: the ranking's error, else the first page's. */
export const listFailureOf = (model: Model) =>
	rankingFailed(model)
		? AsyncData.getError(model.ranking.data)
		: Option.flatMap(Option.fromNullishOr(model.pages[0]), (first) => AsyncData.getError(first.page.data))

export type PagingState = "more" | "loading" | "failed" | "end"

/** Where the list stands relative to the pages it has not shown yet. */
export const pagingOf = (model: Model): PagingState => {
	const last = model.pages[model.pages.length - 1]
	if (last === undefined) return "end"
	const isLater = model.pages.length > 1
	if (isLater && (AsyncData.isLoading(last.page.data) || AsyncData.isIdle(last.page.data))) return "loading"
	if (isLater && AsyncData.isFailure(last.page.data)) return "failed"
	return Option.match(AsyncData.getData(last.page.data), {
		onNone: () => "end",
		onSome: (page) => (page.hasMore && page.nextCursor !== null ? "more" : "end"),
	})
}
