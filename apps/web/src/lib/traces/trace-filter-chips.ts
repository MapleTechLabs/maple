import type { TracesSearchParams } from "@/routes/traces/index"

/**
 * One facet, in both polarities, as the sidebar spells it. `label` has to match the section title
 * exactly — the chip is how you find the section the filter lives in.
 */
const FACETS = [
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Root Span", include: "spanNames", exclude: "excludedSpanNames" },
	{ label: "HTTP Method", include: "httpMethods", exclude: "excludedHttpMethods" },
	{ label: "Status Code", include: "httpStatusCodes", exclude: "excludedHttpStatusCodes" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof TracesSearchParams
	exclude: keyof TracesSearchParams
}>

type ChipSearch = Pick<
	TracesSearchParams,
	(typeof FACETS)[number]["include" | "exclude"] | "attributeFilters" | "resourceAttributeFilters"
>

type AttributeParam = "attributeFilters" | "resourceAttributeFilters"

export interface TraceFilterChipDescriptor {
	/** Stable across renders: the param, plus the entry for attribute filters. */
	id: string
	label: string
	values: readonly string[]
	negated: boolean
	/** The search without this chip's filter. */
	remove: <S extends ChipSearch>(search: S) => S
}

function attributeChips(search: ChipSearch, param: AttributeParam): TraceFilterChipDescriptor[] {
	const prefix = param === "resourceAttributeFilters" ? "resource." : ""
	return (search[param] ?? []).map((entry) => ({
		id: `${param}:${entry.key}:${entry.value}:${entry.negated ? "not" : "is"}`,
		label: `${prefix}${entry.key}${entry.matchMode === "contains" ? " contains" : ""}`,
		values: [entry.value],
		negated: entry.negated === true,
		remove: (s) => {
			const rest = (s[param] ?? []).filter(
				(other) =>
					!(
						other.key === entry.key &&
						other.value === entry.value &&
						other.negated === entry.negated &&
						other.matchMode === entry.matchMode
					),
			)
			return { ...s, [param]: rest.length > 0 ? rest : undefined }
		},
	}))
}

/**
 * The applied facet and attribute filters, ordered as the sidebar orders its sections, with
 * exclusions pinned ahead of inclusions.
 *
 * Exclusions lead because they are the ones that cannot be read off the results: an inclusion shows
 * up as what came back, an exclusion only as what didn't.
 */
export function traceFilterChips(search: ChipSearch): TraceFilterChipDescriptor[] {
	const chips: TraceFilterChipDescriptor[] = []
	for (const facet of FACETS) {
		const values = search[facet.exclude]
		if (values?.length) chips.push(facetChip(facet.exclude, facet.label, values, true))
	}
	for (const facet of FACETS) {
		const values = search[facet.include]
		if (values?.length) chips.push(facetChip(facet.include, facet.label, values, false))
	}
	const attributes = [
		...attributeChips(search, "attributeFilters"),
		...attributeChips(search, "resourceAttributeFilters"),
	]
	chips.push(...attributes.filter((chip) => chip.negated), ...attributes.filter((chip) => !chip.negated))
	return chips
}

function facetChip(
	param: (typeof FACETS)[number]["include" | "exclude"],
	label: string,
	values: readonly string[],
	negated: boolean,
): TraceFilterChipDescriptor {
	return { id: param, label, values, negated, remove: (s) => ({ ...s, [param]: undefined }) }
}

/** The search with every chip's filter removed. */
export function removeTraceFilterChips<S extends ChipSearch>(
	search: S,
	chips: readonly TraceFilterChipDescriptor[],
): S {
	return chips.reduce((acc, chip) => chip.remove(acc), search)
}
