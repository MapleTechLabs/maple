import { encodeJson } from "@maple/views/data/request-key"
import { Array as Arr, String as Str, Option } from "effect"
import { attributeChipText } from "../../../lib/query-builder/where-clause-filters"
import type { TracesSearch } from "../../../route/search"
import type { Facet } from "./message"
import { facetChipsOf } from "../../kit/facets"

export type Search = typeof TracesSearch.Type
type AttributeParam = "attributeFilters" | "resourceAttributeFilters"
type AttributeEntry = NonNullable<Search["attributeFilters"]>[number]

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
	Option.match(
		Arr.findFirst(FACETS, (entry) => entry.include === facet),
		{ onNone: (): ExcludedParam => "excludedServices", onSome: (entry) => entry.exclude },
	)

export interface TraceFilterChip {
	readonly id: string
	readonly label: string
	readonly values: ReadonlyArray<string>
	readonly negated: boolean
	/** The connector in place of is / is not (attribute chips). */
	readonly operator?: string
	/** The search without this chip's filter. */
	readonly remove: (search: Search) => Search
}

const sameEntry = (a: AttributeEntry, b: AttributeEntry): boolean =>
	a.key === b.key &&
	a.value === b.value &&
	a.negated === b.negated &&
	a.matchMode === b.matchMode &&
	encodeJson(a.or ?? []) === encodeJson(b.or ?? [])

const attributeChips = (search: Search, param: AttributeParam): ReadonlyArray<TraceFilterChip> => {
	const prefix = param === "resourceAttributeFilters" ? "resource." : ""
	return Arr.map(search[param] ?? [], (entry) => {
		const text = attributeChipText(prefix, entry)
		const group = entry.or !== undefined && entry.or.length > 0 ? `:or:${encodeJson(entry.or)}` : ""
		const mode = entry.matchMode === undefined ? "" : `:${entry.matchMode}`
		return {
			id: `${param}:${entry.key}:${entry.value}:${entry.negated === true ? "not" : "is"}${mode}${group}`,
			label: text.label,
			values: text.value === "" ? [] : [text.value],
			operator: text.operator,
			negated: entry.negated === true,
			remove: (s: Search): Search => {
				const rest = Arr.filter(s[param] ?? [], (other) => !sameEntry(other, entry))
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
	const facetChips = (isNegated: boolean) =>
		Arr.map(
			facetChipsOf(FACETS, (param) => search[param], isNegated),
			(chip) => facetChip(chip.param, chip.label, chip.values, chip.isNegated),
		)
	const attributes = [
		...attributeChips(search, "attributeFilters"),
		...attributeChips(search, "resourceAttributeFilters"),
	]
	return [
		...facetChips(true),
		...facetChips(false),
		...Arr.filter(attributes, (chip) => chip.negated),
		...Arr.filter(attributes, (chip) => !chip.negated),
	]
}

export const removeTraceFilterChips = (search: Search, chips: ReadonlyArray<TraceFilterChip>): Search =>
	Arr.reduce(chips, search, (acc, chip) => chip.remove(acc))

/** `TracesTable`'s `filtered`: any facet, attribute, where-clause or error/duration filter. */
export const isFiltered = (search: Search): boolean =>
	traceFilterChips(search).length > 0 ||
	Str.trim(search.whereClause ?? "") !== "" ||
	search.hasError === true ||
	search.minDurationMs !== undefined ||
	search.maxDurationMs !== undefined ||
	search.minSpanCount !== undefined

/** The sidebar's `hasActiveFilters`. */
export const hasSidebarFilters = (search: Search): boolean =>
	Arr.some(
		FACETS,
		(facet) => (search[facet.include]?.length ?? 0) > 0 || (search[facet.exclude]?.length ?? 0) > 0,
	) ||
	search.hasError !== undefined ||
	search.minDurationMs !== undefined ||
	search.maxDurationMs !== undefined ||
	(search.attributeFilters?.length ?? 0) > 0 ||
	(search.resourceAttributeFilters?.length ?? 0) > 0
