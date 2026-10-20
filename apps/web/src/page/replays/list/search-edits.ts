import { nextTagSelection } from "../../../components/replays/session-tags"
import type { Facet, Range } from "./message"
import type { Search } from "./model"
import { selectedTags } from "./derive"

// The search edits of the replays page and its filter sidebar.

const withTags = (search: Search, tags: ReadonlyArray<string>): Search => ({
	...search,
	tags: tags.length > 0 ? tags : undefined,
})

/** `setSingle`: the last toggled option wins, unchecking the only one clears it. */
export const toggledFacet = (search: Search, facet: Facet, name: string): Search => ({
	...search,
	[facet]: search[facet] === name ? undefined : name,
})

/** `setTags`: a newly ticked tier replaces the previous tier. */
export const toggledTag = (search: Search, tag: string): Search => {
	const selected = selectedTags(search)
	const values = selected.some((other) => other === tag)
		? selected.filter((other) => other !== tag)
		: [...selected, tag]
	return withTags(search, nextTagSelection(selected, values))
}

/** The toolbar's "engaged" chip. */
export const toggledEngaged = (search: Search): Search => {
	const selected = selectedTags(search)
	return withTags(
		search,
		selected.includes("engaged")
			? selected.filter((tag) => tag !== "engaged")
			: nextTagSelection(selected, [...selected, "engaged"]),
	)
}

/** A row's tag pill adds its tag (`onFilterTag`). */
export const addedRowTag = (search: Search, tag: string): Search => {
	const selected = selectedTags(search)
	return { ...search, tags: nextTagSelection(selected, [...selected, tag]) }
}

export const withRange = (search: Search, range: Range, min: number | undefined, max: number | undefined): Search => {
	const [low, high] = min !== undefined && max !== undefined && min > max ? [max, min] : [min, max]
	return range === "duration"
		? { ...search, durationMin: low, durationMax: high }
		: { ...search, activeMin: low, activeMax: high }
}

/** Clearing filters keeps the time range (the list's empty state). */
export const clearedFilters = (search: Search): Search => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

/** The sidebar's Clear also keeps the URL search. */
export const clearedSidebar = (search: Search): Search => ({ ...clearedFilters(search), q: search.q })

export const textValue = (text: string): string | undefined => {
	const trimmed = text.trim()
	return trimmed === "" ? undefined : trimmed
}
