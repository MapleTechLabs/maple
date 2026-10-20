import { attributeFilterOperator, formatAttributeClause } from "../../../lib/traces/advanced-filter-sync"
import type { TracesSearch } from "../../../route/search"
import type { Facet } from "./message"

export type Search = typeof TracesSearch.Type
type AttributeParam = "attributeFilters" | "resourceAttributeFilters"
type AttributeEntry = NonNullable<Search["attributeFilters"]>[number]

// copied: trace-filter-chips.ts (imports the route module for its search type).

/** One facet in both polarities, as the sidebar spells it. */
export const FACETS = [
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Root span", include: "spanNames", exclude: "excludedSpanNames" },
	{ label: "HTTP method", include: "httpMethods", exclude: "excludedHttpMethods" },
	{ label: "Status code", include: "httpStatusCodes", exclude: "excludedHttpStatusCodes" },
] as const satisfies ReadonlyArray<{ label: string; include: Facet; exclude: keyof Search }>

export type ExcludedParam = (typeof FACETS)[number]["exclude"]

export const excludedOf = (facet: Facet): ExcludedParam =>
	FACETS.find((entry) => entry.include === facet)?.exclude ?? "excludedServices"

export interface TraceFilterChip {
	readonly id: string
	readonly label: string
	readonly values: ReadonlyArray<string>
	readonly negated: boolean
	/** The search without this chip's filter. */
	readonly remove: (search: Search) => Search
}

const sameEntry = (a: AttributeEntry, b: AttributeEntry): boolean =>
	a.key === b.key &&
	a.value === b.value &&
	a.negated === b.negated &&
	a.matchMode === b.matchMode &&
	JSON.stringify(a.or ?? []) === JSON.stringify(b.or ?? [])

const attributeChipText = (prefix: string, entry: AttributeEntry): { label: string; value: string } => {
	if (entry.or !== undefined && entry.or.length > 0)
		return { label: "Any of", value: formatAttributeClause(prefix, { ...entry, or: [...entry.or] }) }
	const label = `${prefix}${entry.key}`
	if (entry.matchMode === "contains") return { label: `${label} contains`, value: entry.value }
	if (entry.matchMode === "exists") return { label, value: "set" }
	if (entry.matchMode !== undefined)
		return { label, value: `${attributeFilterOperator({ matchMode: entry.matchMode })} ${entry.value}` }
	return { label, value: entry.value }
}

const attributeChips = (search: Search, param: AttributeParam): ReadonlyArray<TraceFilterChip> => {
	const prefix = param === "resourceAttributeFilters" ? "resource." : ""
	return (search[param] ?? []).map((entry) => {
		const text = attributeChipText(prefix, entry)
		const group = entry.or !== undefined && entry.or.length > 0 ? `:or:${JSON.stringify(entry.or)}` : ""
		const mode = entry.matchMode === undefined ? "" : `:${entry.matchMode}`
		return {
			id: `${param}:${entry.key}:${entry.value}:${entry.negated === true ? "not" : "is"}${mode}${group}`,
			label: text.label,
			values: [text.value],
			negated: entry.negated === true,
			remove: (s: Search): Search => {
				const rest = (s[param] ?? []).filter((other) => !sameEntry(other, entry))
				return { ...s, [param]: rest.length > 0 ? rest : undefined }
			},
		}
	})
}

const facetChip = (
	param: (typeof FACETS)[number]["include" | "exclude"],
	label: string,
	values: ReadonlyArray<string>,
	negated: boolean,
): TraceFilterChip => ({ id: param, label, values, negated, remove: (s) => ({ ...s, [param]: undefined }) })

/** Applied facet and attribute filters, sidebar order, exclusions first. */
export const traceFilterChips = (search: Search): ReadonlyArray<TraceFilterChip> => {
	const facetChips = (polarity: "include" | "exclude") =>
		FACETS.flatMap((facet) => {
			const values = search[facet[polarity]]
			return values === undefined || values.length === 0
				? []
				: [facetChip(facet[polarity], facet.label, values, polarity === "exclude")]
		})
	const attributes = [
		...attributeChips(search, "attributeFilters"),
		...attributeChips(search, "resourceAttributeFilters"),
	]
	return [
		...facetChips("exclude"),
		...facetChips("include"),
		...attributes.filter((chip) => chip.negated),
		...attributes.filter((chip) => !chip.negated),
	]
}

export const removeTraceFilterChips = (search: Search, chips: ReadonlyArray<TraceFilterChip>): Search =>
	chips.reduce((acc, chip) => chip.remove(acc), search)

/** `TracesTable`'s `filtered`: any facet, attribute, where-clause or error/duration filter. */
export const isFiltered = (search: Search): boolean =>
	traceFilterChips(search).length > 0 ||
	(search.whereClause ?? "").trim() !== "" ||
	search.hasError === true ||
	search.minDurationMs !== undefined ||
	search.maxDurationMs !== undefined ||
	search.minSpanCount !== undefined

/** The sidebar's `hasActiveFilters`. */
export const hasSidebarFilters = (search: Search): boolean =>
	FACETS.some(
		(facet) => (search[facet.include]?.length ?? 0) > 0 || (search[facet.exclude]?.length ?? 0) > 0,
	) ||
	search.hasError !== undefined ||
	search.minDurationMs !== undefined ||
	search.maxDurationMs !== undefined ||
	(search.attributeFilters?.length ?? 0) > 0 ||
	(search.resourceAttributeFilters?.length ?? 0) > 0

// copied: `canWidenTimeRange` and `WIDEN_TIME_PRESET` (time-range-picker/search.ts imports `@/` types).
export const WIDEN_TIME_PRESET = "7d"
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
export const canWidenTimeRange = (search: Search, defaultPreset: string): boolean =>
	search.startTime === undefined && !WIDE_TIME_PRESETS.has(search.timePreset ?? defaultPreset)
