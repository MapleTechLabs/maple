import type { AiSessionSortDir, AiSessionSortKey } from "@maple/domain/http"
import type { ListAiSessionsInput } from "@maple/web-data/warehouse/ai-sessions"
import type { Types } from "effect"
import { AsyncData } from "foldkit"
import type { TimeWindow } from "../../../data/time-range"
import type { AgentSessionsSearch } from "../../../route/search"
import type { Model, RangeKey, SessionRow } from "./model"

// copied: agent-sessions-filter-inputs.ts (it imports a hook type through `@/`) and the paging
// arithmetic of `useInfiniteAiSessions`.

export type Search = typeof AgentSessionsSearch.Type

export const PAGE_SIZE = 50
export const MAX_RETAINED_SESSIONS = 500

/** A page's ranked count, falling back to its row count for a server that predates the field. */
export const rankedOf = (page: { readonly data: ReadonlyArray<unknown>; readonly ranked?: number }): number =>
	page.ranked ?? page.data.length

export const FILTER_KEYS = [
	"vendors",
	"services",
	"environments",
	"models",
	"agents",
	"tools",
	"q",
	"hasErrors",
	"grouped",
	"durationMin",
	"durationMax",
	"costMin",
	"costMax",
	"tokensMin",
	"tokensMax",
	"llmCallsMin",
	"llmCallsMax",
	"toolCallsMin",
	"toolCallsMax",
] as const satisfies ReadonlyArray<keyof Search>

/** Each range section's URL params. */
export const RANGE_PARAMS = {
	duration: ["durationMin", "durationMax"],
	cost: ["costMin", "costMax"],
	tokens: ["tokensMin", "tokensMax"],
	llmCalls: ["llmCallsMin", "llmCallsMax"],
	toolCalls: ["toolCallsMin", "toolCallsMax"],
} as const satisfies Record<RangeKey, readonly [keyof Search, keyof Search]>

export type Sort = Readonly<{ sortBy: AiSessionSortKey; sortDir: AiSessionSortDir }>

const DEFAULT_SORT: Sort = { sortBy: "startTime", sortDir: "desc" }

const isDefaultSort = (sort: Sort) =>
	sort.sortBy === DEFAULT_SORT.sortBy && sort.sortDir === DEFAULT_SORT.sortDir

export const sortOf = (search: Search): Sort => ({
	sortBy: search.sortBy ?? DEFAULT_SORT.sortBy,
	sortDir: search.sortDir ?? DEFAULT_SORT.sortDir,
})

/** The sorted column flips; any other starts descending; the default order clears both params. */
export const sortPatch = (
	search: Search,
	key: AiSessionSortKey,
): { sortBy: AiSessionSortKey | undefined; sortDir: AiSessionSortDir | undefined } => {
	const current = sortOf(search)
	const sortDir: AiSessionSortDir = key === current.sortBy && current.sortDir === "desc" ? "asc" : "desc"
	return isDefaultSort({ sortBy: key, sortDir })
		? { sortBy: undefined, sortDir: undefined }
		: { sortBy: key, sortDir }
}

export const hasFilters = (search: Search): boolean =>
	FILTER_KEYS.some((key) => {
		const value = search[key]
		return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false
	})

const some = (values: ReadonlyArray<string> | undefined) =>
	values !== undefined && values.length > 0 ? [...values] : undefined

export type FilterInputs = Omit<ListAiSessionsInput, "limit" | "offset">

/** The warehouse filter inputs for a search and the resolved window. */
export const filterInputs = (search: Search, window: TimeWindow): FilterInputs => {
	const sort = sortOf(search)
	const query = search.q?.trim()
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		vendorIds: some(search.vendors),
		serviceNames: some(search.services),
		deploymentEnvs: some(search.environments),
		models: some(search.models),
		agentNames: some(search.agents),
		toolNames: some(search.tools),
		search: query === undefined || query === "" ? undefined : query,
		hasErrors: search.hasErrors === true ? true : undefined,
		excludeTraceSessions: search.grouped === true ? true : undefined,
		durationMinMs: search.durationMin === undefined ? undefined : search.durationMin * 1000,
		durationMaxMs: search.durationMax === undefined ? undefined : search.durationMax * 1000,
		costMin: search.costMin,
		costMax: search.costMax,
		tokensMin: search.tokensMin,
		tokensMax: search.tokensMax,
		llmCallsMin: search.llmCallsMin,
		llmCallsMax: search.llmCallsMax,
		toolCallsMin: search.toolCallsMin,
		toolCallsMax: search.toolCallsMax,
		...(isDefaultSort(sort) ? undefined : sort),
	}
}

const OPTIONAL_INPUT_KEYS = [
	"vendorIds",
	"serviceNames",
	"deploymentEnvs",
	"models",
	"agentNames",
	"toolNames",
	"search",
	"hasErrors",
	"excludeTraceSessions",
	"durationMinMs",
	"durationMaxMs",
	"costMin",
	"costMax",
	"tokensMin",
	"tokensMax",
	"llmCallsMin",
	"llmCallsMax",
	"toolCallsMin",
	"toolCallsMax",
	"sortBy",
	"sortDir",
] as const satisfies ReadonlyArray<keyof FilterInputs>

/** The inputs without their unset keys, as a JSON round trip would leave them. */
export const presentInputs = (inputs: FilterInputs): FilterInputs => {
	const present: Types.Mutable<FilterInputs> = {
		startTime: inputs.startTime,
		endTime: inputs.endTime,
	}
	const copy = <K extends (typeof OPTIONAL_INPUT_KEYS)[number]>(key: K) => {
		const value = inputs[key]
		if (value !== undefined) present[key] = value
	}
	OPTIONAL_INPUT_KEYS.forEach(copy)
	return present
}

/** The filters the details read is scoped by; a sort or window change keeps them. */
export const countedFilters = (inputs: FilterInputs) => ({
	vendorIds: inputs.vendorIds,
	serviceNames: inputs.serviceNames,
	deploymentEnvs: inputs.deploymentEnvs,
	models: inputs.models,
	agentNames: inputs.agentNames,
	toolNames: inputs.toolNames,
	search: inputs.search,
})

/** `JSON.stringify` keys, like the hook's memo keys. */
export const filterKeyOf = (inputs: FilterInputs): string => JSON.stringify(inputs)
export const detailsKeyOf = (inputs: FilterInputs): string => JSON.stringify(countedFilters(inputs))

/** The rows as the pages returned them, before their details. */
export const pageRows = (model: Model, filterKey: string): ReadonlyArray<SessionRow> => {
	const first = AsyncData.getOrElse(model.firstPage.data, () => ({ data: [], ranked: 0 }))
	const more = model.morePages.filterKey === filterKey ? model.morePages.pages : []
	return [...first.data, ...more.flatMap((page) => page.data)].slice(0, MAX_RETAINED_SESSIONS)
}

export type DisplayRow = SessionRow & { readonly hasDetails: boolean }

/** Rows with their details merged in; the ranked measures stay the index's. */
export const displayedRows = (model: Model, filterKey: string): ReadonlyArray<DisplayRow> =>
	pageRows(model, filterKey).map((row) => {
		const detailed = model.details.bySession[row.sessionId]
		return detailed === undefined
			? { ...row, hasDetails: false }
			: {
					...row,
					...detailed,
					durationMs: row.durationMs,
					errorSpanCount: row.errorSpanCount,
					hasDetails: true,
				}
	})

export const hasNextPage = (model: Model, filterKey: string): boolean => {
	const first = AsyncData.getData(model.firstPage.data)
	if (first._tag === "None" || model.isPaginationStopped) return false
	if (pageRows(model, filterKey).length >= MAX_RETAINED_SESSIONS) return false
	const more = model.morePages.filterKey === filterKey ? model.morePages.pages : []
	const last = more.at(-1)
	return (last === undefined ? first.value.ranked : last.ranked) === PAGE_SIZE
}

/** The next offset: what the server ranked so far. */
export const rankedCount = (model: Model, filterKey: string): number => {
	const first = AsyncData.getOrElse(model.firstPage.data, () => ({ data: [], ranked: 0 })).ranked
	const more = model.morePages.filterKey === filterKey ? model.morePages.pages : []
	return more.reduce((sum, page) => sum + page.ranked, first)
}
