// The include/exclude arithmetic of a tri-state `FilterSection` (packages/ui/src/components/filters),
// as applied to a page's URL search: an empty list leaves the URL, and a value is never both included and
// excluded. The page maps the result back onto its own search keys.

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
		excluded: excluded.includes(name) ? listOrUndefined(excluded.filter((v) => v !== name)) : lists.excluded,
		selected: listOrUndefined(selected.includes(name) ? selected.filter((v) => v !== name) : [...selected, name]),
	}
}

/** "Only": this value alone, no exclusions. */
export const onlyValue = (name: string): FacetLists => ({ selected: [name], excluded: undefined })

/** "Exclude": toggle the exclusion, dropping an inclusion of the same value. */
export const excludedValue = (lists: FacetLists, name: string): FacetLists => {
	const selected = lists.selected ?? []
	const excluded = lists.excluded ?? []
	return {
		selected: selected.includes(name) ? listOrUndefined(selected.filter((v) => v !== name)) : lists.selected,
		excluded: listOrUndefined(excluded.includes(name) ? excluded.filter((v) => v !== name) : [...excluded, name]),
	}
}

/** `*FilterChips`: the applied facets, exclusions first. */
export const facetChips = <P extends string>(
	facets: ReadonlyArray<Readonly<{ label: string; include: P; exclude: P }>>,
	read: (param: P) => ReadonlyArray<string> | undefined,
): ReadonlyArray<Readonly<{ param: P; label: string; values: ReadonlyArray<string>; isNegated: boolean }>> => {
	const chip = (param: P, label: string, isNegated: boolean) => {
		const values = read(param)
		return values === undefined || values.length === 0 ? [] : [{ param, label, values, isNegated }]
	}
	return [
		...facets.flatMap((facet) => chip(facet.exclude, facet.label, true)),
		...facets.flatMap((facet) => chip(facet.include, facet.label, false)),
	]
}
