import { decodeLogAttributeFilter, logAttributeQueryFilters } from "@maple/web/lib/logs/log-attribute-filters"
import { SEVERITY_ORDER } from "@maple/ui/lib/severity"
import type { CustomChartTimeSeriesInput } from "@maple/web-data/warehouse/custom-charts"
import type { ListLogsInput } from "@maple/web-data/warehouse/logs"
import type { LogsSearch } from "../../../route/search"
import type { TimeWindow } from "../../../data/time-range"
import type { LogRowSchema, LogsPage, Pagination, VolumeBucket } from "./model"

export type Search = typeof LogsSearch.Type

/** `useInfiniteLogs`' page size, its reach-end threshold and the retention cap. */
export const PAGE_SIZE = 100
export const FETCH_THRESHOLD = 20
export const MAX_RETAINED_LOGS = 2_000

const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

/**
 * `buildQueryParams`: the org-global pin overrides the URL's namespace filters (they stay in the
 * URL; unpinning restores them). The first page and every later page send exactly this.
 */
export const listInput = (
	search: Search,
	window: TimeWindow,
	pinnedNamespace: string | null,
): ListLogsInput => {
	const isPinned = pinnedNamespace !== null
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		services: mutable(search.services),
		severities: mutable(search.severities),
		deploymentEnvs: mutable(search.deploymentEnvs),
		deploymentEnvMatchMode: search.deploymentEnvMatchMode,
		namespaces: isPinned ? [pinnedNamespace] : mutable(search.namespaces),
		namespaceMatchMode: isPinned ? undefined : search.namespaceMatchMode,
		excludedServices: mutable(search.excludedServices),
		excludedSeverities: mutable(search.excludedSeverities),
		excludedDeploymentEnvs: mutable(search.excludedDeploymentEnvs),
		excludedNamespaces: isPinned ? undefined : mutable(search.excludedNamespaces),
		search: search.search,
		traceId: search.traceId,
		...logAttributeQueryFilters(search.attrs),
	}
}

/** The logs the stream shows: the first page then every later one, capped. */
export const allLogs = (
	firstPage: LogsPage | undefined,
	pagination: Pagination,
): ReadonlyArray<LogRowSchema> =>
	[...(firstPage?.logs ?? []), ...pagination.pages.flatMap((page) => page.logs)].slice(0, MAX_RETAINED_LOGS)

/** The cursor the next page starts after, `null` when the last page came back short. */
export const lastCursor = (firstPage: LogsPage | undefined, pagination: Pagination): string | null =>
	pagination.pages.at(-1)?.cursor ?? (pagination.pages.length > 0 ? null : (firstPage?.cursor ?? null))

export const hasNextPage = (firstPage: LogsPage | undefined, pagination: Pagination): boolean =>
	allLogs(firstPage, pagination).length < MAX_RETAINED_LOGS &&
	!pagination.isStopped &&
	lastCursor(firstPage, pagination) !== null

// FILTER CHIPS
// copied: apps/web/src/lib/logs/log-filter-chips.ts (its `@/` type import cannot be typechecked here).

const FACETS = [
	{ label: "Severity", include: "severities", exclude: "excludedSeverities" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
] as const

export type ChipParam = (typeof FACETS)[number]["include" | "exclude"] | "traceId" | "attrs"

export interface LogFilterChip {
	readonly param: ChipParam
	readonly label: string
	readonly values: ReadonlyArray<string>
	readonly negated: boolean
	/** Set on attribute chips: the one `attrs` entry the chip removes, not the whole param. */
	readonly attr?: string
}

/** The applied facet filters, exclusions first; the trace scope leads them all. */
export const logFilterChips = (search: Search): ReadonlyArray<LogFilterChip> => {
	const attrs = (search.attrs ?? []).flatMap((entry) => {
		const filter = decodeLogAttributeFilter(entry)
		return filter ? [{ entry, filter }] : []
	})
	const facetChips = (isNegated: boolean): ReadonlyArray<LogFilterChip> =>
		FACETS.flatMap((facet) => {
			const param = isNegated ? facet.exclude : facet.include
			const values = search[param]
			return values !== undefined && values.length > 0
				? [{ param, label: facet.label, values, negated: isNegated }]
				: []
		})
	const attrChips = (isNegated: boolean): ReadonlyArray<LogFilterChip> =>
		attrs
			.filter((a) => a.filter.negated === isNegated)
			.map(({ entry, filter }) => ({
				param: "attrs" as const,
				label: filter.key,
				values: [filter.value],
				negated: isNegated,
				attr: entry,
			}))
	return [
		...(search.traceId
			? [{ param: "traceId" as const, label: "Trace", values: [search.traceId], negated: false }]
			: []),
		...facetChips(true),
		...attrChips(true),
		...facetChips(false),
		...attrChips(false),
	]
}

/** The search with these chips' filters removed: a facet chip clears its param, an attribute chip its entry. */
export const withoutChips = (search: Search, chips: ReadonlyArray<LogFilterChip>): Search => {
	const cleared = Object.fromEntries(
		chips.filter((chip) => chip.attr === undefined).map((chip) => [chip.param, undefined]),
	)
	const dropped = new Set(chips.flatMap((chip) => (chip.attr === undefined ? [] : [chip.attr])))
	const attrs = (search.attrs ?? []).filter((entry) => !dropped.has(entry))
	return { ...search, ...cleared, attrs: attrs.length > 0 ? attrs : undefined }
}

// VOLUME

/** `LogsVolumeChart`'s denser histogram target, and its request. */
export const HISTOGRAM_TARGET_POINTS = 150

export const volumeInput = (
	search: Search,
	window: TimeWindow,
	bucketSeconds: number,
	pinnedNamespace: string | null,
): CustomChartTimeSeriesInput => ({
	source: "logs",
	metric: "count",
	groupBy: "severity",
	startTime: window.startTime,
	endTime: window.endTime,
	bucketSeconds,
	filters: {
		serviceNames: mutable(search.services),
		severities: mutable(search.severities),
		environments: mutable(search.deploymentEnvs),
		namespaces: pinnedNamespace !== null ? [pinnedNamespace] : mutable(search.namespaces),
		excludedServiceNames: mutable(search.excludedServices),
		excludedSeverities: mutable(search.excludedSeverities),
		excludedEnvironments: mutable(search.excludedDeploymentEnvs),
		excludedNamespaces: pinnedNamespace === null ? mutable(search.excludedNamespaces) : undefined,
		traceId: search.traceId,
		...logAttributeQueryFilters(search.attrs),
	},
})

/** Severities fold case-insensitively (SDKs ship `INFO`, `Info` and `info` side by side). */
export const toVolumeBuckets = (
	points: ReadonlyArray<{ readonly bucket: string; readonly series: Readonly<Record<string, number>> }>,
): ReadonlyArray<VolumeBucket> =>
	points.map((point) => {
		const counts = new Map<string, number>()
		Object.entries(point.series).forEach(([key, value]) => {
			if (typeof value !== "number") return
			const canonical = key.toUpperCase()
			counts.set(canonical, (counts.get(canonical) ?? 0) + value)
		})
		return { bucket: point.bucket, counts: Object.fromEntries(counts) }
	})

/** Known severities in `SEVERITY_ORDER`, then any others in arrival order. */
export const volumeSeriesKeys = (buckets: ReadonlyArray<VolumeBucket>): ReadonlyArray<string> => {
	const seen = new Set(buckets.flatMap((bucket) => Object.keys(bucket.counts)))
	const known = SEVERITY_ORDER.filter((severity) => seen.has(severity))
	return [...known, ...[...seen].filter((key) => !known.includes(key))]
}

export const volumeTotal = (buckets: ReadonlyArray<VolumeBucket>): number =>
	buckets.reduce((sum, bucket) => sum + Object.values(bucket.counts).reduce((s, v) => s + v, 0), 0)

/** The chip's id in `ActiveFilterChips`: its param, or `attrs:<entry>`. */
export const chipId = (chip: LogFilterChip): string =>
	chip.attr === undefined ? chip.param : `attrs:${chip.attr}`
