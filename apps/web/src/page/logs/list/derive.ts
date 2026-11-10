import { decodeLogAttributeFilter, logAttributeQueryFilters } from "@maple/views/lib/log-attribute-filters"
import type { AttributeFilter } from "@maple/domain"
import { attributeChipText, toQueryAttributeFilter } from "../../../lib/query-builder/where-clause-filters"
import { clauseParams } from "../../../lib/logs/advanced-filter-sync"
import { SEVERITY_ORDER } from "@maple/ui/lib/severity"
import type { CustomChartTimeSeriesInput } from "@maple/web-data/warehouse/custom-charts"
import type { ListLogsInput } from "@maple/web-data/warehouse/logs"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { inferBucketSeconds } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { LogsSearch } from "../../../route/search"
import type { TimeWindow } from "../../../data/time-range"
import type { LogRowSchema, LogsPage, Model, Pagination, VolumeBucket } from "./model"
import { Array as Arr, Record as Rec, String as Str } from "effect"

export type Search = typeof LogsSearch.Type

/** `useInfiniteLogs`' page size, its reach-end threshold and the retention cap. */
export const PAGE_SIZE = 100
export const FETCH_THRESHOLD = 20
export const MAX_RETAINED_LOGS = 2_000

/** `LogsInspectState.inspecting`: the tail holds while the sheet is open, or while hovering/scrolled. */
export const isInspectingOf = (model: Model): boolean =>
	model.isInspecting || (model.detail.dialog.isOpen && model.stream.rows.length > 0)

/**
 * `handleMouseUp`: the dragged buckets as a window, the right edge widened by one bucket so the last
 * bar is in. `undefined` for a click without a drag or an unreadable bucket.
 */
export const brushRange = (
	left: string,
	right: string,
	buckets: ReadonlyArray<VolumeBucket>,
): { startTime: string; endTime: string } | undefined => {
	const leftMs = toEpochMs(left)
	const rightMs = toEpochMs(right)
	if (Number.isNaN(leftMs) || Number.isNaN(rightMs) || leftMs === rightMs) return undefined
	const bucketMs = (inferBucketSeconds(buckets) ?? 300) * 1000
	return {
		startTime: formatWarehouseDateTime(Math.min(leftMs, rightMs)),
		endTime: formatWarehouseDateTime(Math.max(leftMs, rightMs) + bucketMs),
	}
}

const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

type AttributeParam = "attributeFilters" | "resourceAttributeFilters"

const joined = (...lists: ReadonlyArray<ReadonlyArray<AttributeFilter> | undefined>) => {
	const all = Arr.flatten(Arr.map(lists, (list) => list ?? []))
	return all.length > 0 ? all : undefined
}

/** The sheet's `attrs` chips and the advanced filter's attribute predicates, as the request takes them. */
export const attributeQueryFilters = (search: Search) => {
	const chips = logAttributeQueryFilters(search.attrs)
	const clause = (param: AttributeParam) => Arr.map(search[param] ?? [], toQueryAttributeFilter)
	return {
		attributeFilters: joined(chips.attributeFilters, clause("attributeFilters")),
		resourceAttributeFilters: joined(chips.resourceAttributeFilters, clause("resourceAttributeFilters")),
	}
}

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
		...attributeQueryFilters(search),
	}
}

/** The logs the stream shows: the first page then every later one, capped. */
export const allLogs = (
	firstPage: LogsPage | undefined,
	pagination: Pagination,
): ReadonlyArray<LogRowSchema> =>
	[...(firstPage?.logs ?? []), ...Arr.flatMap(pagination.pages, (page) => page.logs)].slice(
		0,
		MAX_RETAINED_LOGS,
	)

/** The cursor the next page starts after, `null` when the last page came back short. */
export const lastCursor = (firstPage: LogsPage | undefined, pagination: Pagination): string | null =>
	pagination.pages.at(-1)?.cursor ?? (pagination.pages.length > 0 ? null : (firstPage?.cursor ?? null))

export const hasNextPage = (firstPage: LogsPage | undefined, pagination: Pagination): boolean =>
	allLogs(firstPage, pagination).length < MAX_RETAINED_LOGS &&
	!pagination.isStopped &&
	lastCursor(firstPage, pagination) !== null

// Presets already wide enough that widening the range would not help.
const WIDE_TIME_PRESETS = new Set([
	"7d",
	"1w",
	"10d",
	"14d",
	"2w",
	"30d",
	"6w",
	"1mo",
	"2mo",
	"3mo",
	"6mo",
	"12mo",
])

/** Widening only helps from a short relative preset (`LogsTable` passes `""` as the default). */
export const canWidenRange = (search: Search): boolean =>
	search.startTime === undefined && !WIDE_TIME_PRESETS.has(search.timePreset ?? "")

// FILTER CHIPS

const FACETS = [
	{ label: "Severity", include: "severities", exclude: "excludedSeverities" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
] as const

export type ChipParam = (typeof FACETS)[number]["include" | "exclude"] | "traceId" | "attrs" | AttributeParam

export interface LogFilterChip {
	readonly param: ChipParam
	readonly label: string
	readonly values: ReadonlyArray<string>
	readonly negated: boolean
	/** Set on attribute chips: the one `attrs` entry the chip removes, not the whole param. */
	readonly attr?: string
	/** Set on advanced-filter attribute chips: the index of the entry the chip removes. */
	readonly index?: number
	/** The connector in place of is / is not (advanced-filter attribute chips). */
	readonly operator?: string
}

/** The substring mode an include list carries (`env contains "prod"`); it goes when the list changes. */
const matchModeOf = (param: string) =>
	param === "deploymentEnvs"
		? ("deploymentEnvMatchMode" as const)
		: param === "namespaces"
			? ("namespaceMatchMode" as const)
			: undefined

/** The search with `param`'s substring mode cleared, if it has one. */
export const withoutMatchMode = (search: Search, param: string): Search => {
	const mode = matchModeOf(param)
	return mode === undefined ? search : { ...search, [mode]: undefined }
}

/** The applied facet filters, exclusions first; the trace scope leads them all. */
export const logFilterChips = (search: Search): ReadonlyArray<LogFilterChip> => {
	const attrs = Arr.flatMap(search.attrs ?? [], (entry) => {
		const filter = decodeLogAttributeFilter(entry)
		return filter ? [{ entry, filter }] : []
	})
	const facetChips = (isNegated: boolean): ReadonlyArray<LogFilterChip> =>
		Arr.flatMap(FACETS, (facet) => {
			const param = isNegated ? facet.exclude : facet.include
			const values = search[param]
			const mode = matchModeOf(param)
			const operator = mode !== undefined && search[mode] === "contains" ? "contains" : undefined
			return values !== undefined && values.length > 0
				? [{ param, label: facet.label, values, negated: isNegated, operator }]
				: []
		})
	const attrChips = (isNegated: boolean): ReadonlyArray<LogFilterChip> =>
		Arr.map(
			Arr.filter(attrs, (a) => a.filter.negated === isNegated),
			({ entry, filter }) => ({
				param: "attrs" as const,
				label: filter.key,
				values: [filter.value],
				negated: isNegated,
				attr: entry,
			}),
		)
	const clauseChips = (isNegated: boolean): ReadonlyArray<LogFilterChip> =>
		Arr.flatMap(["attributeFilters", "resourceAttributeFilters"] as const, (param) =>
			Arr.flatMap(search[param] ?? [], (entry, index) => {
				if ((entry.negated === true) !== isNegated) return []
				const text = attributeChipText(param === "resourceAttributeFilters" ? "resource." : "", entry)
				const values = text.value === "" ? [] : [text.value]
				return [
					{ param, label: text.label, values, operator: text.operator, negated: isNegated, index },
				]
			}),
		)
	return [
		...(search.traceId
			? [{ param: "traceId" as const, label: "Trace", values: [search.traceId], negated: false }]
			: []),
		...facetChips(true),
		...attrChips(true),
		...clauseChips(true),
		...facetChips(false),
		...attrChips(false),
		...clauseChips(false),
	]
}

/** The search with these chips' filters removed: a facet chip clears its param, an attribute chip its entry. */
export const withoutChips = (search: Search, chips: ReadonlyArray<LogFilterChip>): Search => {
	const cleared = Rec.fromEntries(
		Arr.flatMap(
			Arr.filter(chips, (chip) => chip.attr === undefined && chip.index === undefined),
			(chip: LogFilterChip): ReadonlyArray<readonly [string, undefined]> => {
				const mode = matchModeOf(chip.param)
				return mode === undefined
					? [[chip.param, undefined]]
					: [
							[chip.param, undefined],
							[mode, undefined],
						]
			},
		),
	)
	const dropped = new Set(Arr.flatMap(chips, (chip) => (chip.attr === undefined ? [] : [chip.attr])))
	const attrs = Arr.filter(search.attrs ?? [], (entry) => !dropped.has(entry))
	const kept = (param: AttributeParam) => {
		const indexes = new Set(
			Arr.flatMap(chips, (chip) =>
				chip.param === param && chip.index !== undefined ? [chip.index] : [],
			),
		)
		const rest = Arr.filter(search[param] ?? [], (_, index) => !indexes.has(index))
		return rest.length > 0 ? rest : undefined
	}
	// A chip the advanced filter set takes the clause with it: the panel no longer describes the list.
	const owned = clauseParams(search.whereClause)
	const isClauseEdited = Arr.some(chips, (chip) => owned.includes(chip.param))
	return {
		...search,
		...cleared,
		attrs: attrs.length > 0 ? attrs : undefined,
		attributeFilters: kept("attributeFilters"),
		resourceAttributeFilters: kept("resourceAttributeFilters"),
		whereClause: isClauseEdited ? undefined : search.whereClause,
	}
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
		deploymentEnvMatchMode: search.deploymentEnvMatchMode,
		namespaces: pinnedNamespace !== null ? [pinnedNamespace] : mutable(search.namespaces),
		namespaceMatchMode: pinnedNamespace === null ? search.namespaceMatchMode : undefined,
		excludedServiceNames: mutable(search.excludedServices),
		excludedSeverities: mutable(search.excludedSeverities),
		excludedEnvironments: mutable(search.excludedDeploymentEnvs),
		excludedNamespaces: pinnedNamespace === null ? mutable(search.excludedNamespaces) : undefined,
		traceId: search.traceId,
		...attributeQueryFilters(search),
	},
})

/** Severities fold case-insensitively (SDKs ship `INFO`, `Info` and `info` side by side). */
export const toVolumeBuckets = (
	points: ReadonlyArray<{ readonly bucket: string; readonly series: Readonly<Record<string, number>> }>,
): ReadonlyArray<VolumeBucket> =>
	Arr.map(points, (point) => {
		const counts = new Map<string, number>()
		Arr.forEach(Rec.toEntries(point.series), ([key, value]) => {
			if (typeof value !== "number") return
			const canonical = Str.toUpperCase(key)
			counts.set(canonical, (counts.get(canonical) ?? 0) + value)
		})
		return { bucket: point.bucket, counts: Rec.fromEntries(counts) }
	})

/** Known severities in `SEVERITY_ORDER`, then any others in arrival order. */
export const volumeSeriesKeys = (buckets: ReadonlyArray<VolumeBucket>): ReadonlyArray<string> => {
	const seen = new Set(Arr.flatMap(buckets, (bucket) => Rec.keys(bucket.counts)))
	const known = Arr.filter(SEVERITY_ORDER, (severity) => seen.has(severity))
	return [...known, ...Arr.filter([...seen], (key) => !known.includes(key))]
}

export const volumeTotal = (buckets: ReadonlyArray<VolumeBucket>): number =>
	Arr.reduce(buckets, 0, (sum, bucket) => sum + Arr.reduce(Rec.values(bucket.counts), 0, (s, v) => s + v))

/** The chip's id in `ActiveFilterChips`: its param, `attrs:<entry>` or `<param>:<index>`. */
export const chipId = (chip: LogFilterChip): string =>
	chip.attr !== undefined
		? `attrs:${chip.attr}`
		: chip.index !== undefined
			? `${chip.param}:${chip.index}`
			: chip.param
