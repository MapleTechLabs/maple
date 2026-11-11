import { Array as Arr } from "effect"

// The include/exclude arithmetic of a tri-state facet filter, as applied to a page's URL search:
// an empty list leaves the URL, and a value is never both included and excluded.

export type FacetLists = Readonly<{
	selected: ReadonlyArray<string> | undefined
	excluded: ReadonlyArray<string> | undefined
}>

const listOrUndefined = (values: ReadonlyArray<string>) => (values.length === 0 ? undefined : values)

/** The checkbox: include the value, or drop it from both lists. */
export const toggledValue = (lists: FacetLists, name: string): FacetLists => {
	const selected = lists.selected ?? []
	const excluded = lists.excluded ?? []
	return {
		excluded: excluded.includes(name)
			? listOrUndefined(Arr.filter(excluded, (v) => v !== name))
			: lists.excluded,
		selected: listOrUndefined(
			selected.includes(name) ? Arr.filter(selected, (v) => v !== name) : [...selected, name],
		),
	}
}

/** "Only": this value alone, no exclusions. */
export const onlyValue = (name: string): FacetLists => ({ selected: [name], excluded: undefined })

/** "Exclude": toggle the exclusion, dropping an inclusion of the same value. */
export const excludedValue = (lists: FacetLists, name: string): FacetLists => {
	const selected = lists.selected ?? []
	const excluded = lists.excluded ?? []
	return {
		selected: selected.includes(name)
			? listOrUndefined(Arr.filter(selected, (v) => v !== name))
			: lists.selected,
		excluded: listOrUndefined(
			excluded.includes(name) ? Arr.filter(excluded, (v) => v !== name) : [...excluded, name],
		),
	}
}

/** A facet's two URL params: the values it includes and the values it excludes. */
export type FacetParams<I extends string, E extends string> = Readonly<{ include: I; exclude: E }>

type FacetSearch<I extends string, E extends string> = {
	readonly [K in I | E]?: ReadonlyArray<string> | undefined
}

/** Applies one of the edits above to a facet's two params on a page's search. */
export const editFacet = <I extends string, E extends string, S extends FacetSearch<I, E>>(
	search: S,
	params: FacetParams<I, E>,
	edit: (lists: FacetLists) => FacetLists,
): S => {
	const next = edit({ selected: search[params.include], excluded: search[params.exclude] })
	return { ...search, [params.include]: next.selected, [params.exclude]: next.excluded }
}

export type FacetChip<P extends string> = Readonly<{
	param: P
	label: string
	values: ReadonlyArray<string>
	isNegated: boolean
}>

/** The applied facets of one polarity, in the facets' order. */
export const facetChipsOf = <P extends string>(
	facets: ReadonlyArray<Readonly<{ label: string; include: P; exclude: P }>>,
	read: (param: P) => ReadonlyArray<string> | undefined,
	isNegated: boolean,
): ReadonlyArray<FacetChip<P>> =>
	Arr.flatMap(facets, (facet) => {
		const param = isNegated ? facet.exclude : facet.include
		const values = read(param)
		return values === undefined || values.length === 0
			? []
			: [{ param, label: facet.label, values, isNegated }]
	})

/** The applied facets, exclusions first. */
export const facetChips = <P extends string>(
	facets: ReadonlyArray<Readonly<{ label: string; include: P; exclude: P }>>,
	read: (param: P) => ReadonlyArray<string> | undefined,
): ReadonlyArray<FacetChip<P>> => [...facetChipsOf(facets, read, true), ...facetChipsOf(facets, read, false)]
