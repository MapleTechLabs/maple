import type { AiSessionSortDir, AiSessionSortKey } from "@maple/domain/http"
import type { AiSessionsFilterInputs } from "@/hooks/use-infinite-ai-sessions"

/**
 * The URL state the agent-sessions list filters on. Structurally the decoded
 * search schema from the route, declared here so this module stays importable
 * without pulling in the route (and its component tree).
 */
export interface AgentSessionsSearchState {
	readonly vendors?: ReadonlyArray<string>
	readonly services?: ReadonlyArray<string>
	readonly environments?: ReadonlyArray<string>
	readonly models?: ReadonlyArray<string>
	readonly agents?: ReadonlyArray<string>
	readonly tools?: ReadonlyArray<string>
	/** Session or trace id prefix. */
	readonly q?: string
	readonly hasErrors?: boolean
	/** Hide the `trace:` sessions — traces whose vendor exposes no session key. */
	readonly grouped?: boolean
	/** Seconds, like the replays list; the warehouse filters in ms. */
	readonly durationMin?: number
	readonly durationMax?: number
	readonly costMin?: number
	readonly costMax?: number
	readonly tokensMin?: number
	readonly tokensMax?: number
	readonly llmCallsMin?: number
	readonly llmCallsMax?: number
	readonly toolCallsMin?: number
	readonly toolCallsMax?: number
	readonly sortBy?: AiSessionSortKey
	readonly sortDir?: AiSessionSortDir
}

/** The URL keys that are filters — everything the sidebar's Clear resets. */
export const AGENT_SESSIONS_FILTER_KEYS = [
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
] as const satisfies ReadonlyArray<keyof AgentSessionsSearchState>

export interface AgentSessionsSort {
	readonly sortBy: AiSessionSortKey
	readonly sortDir: AiSessionSortDir
}

/** The order the list reads in when the URL names none: newest first. */
const DEFAULT_SORT: AgentSessionsSort = { sortBy: "startTime", sortDir: "desc" }

const isDefaultSort = (sort: AgentSessionsSort) =>
	sort.sortBy === DEFAULT_SORT.sortBy && sort.sortDir === DEFAULT_SORT.sortDir

/** The order a URL names, with either half it leaves off taken from the default. */
export function agentSessionsSort(search: Pick<AgentSessionsSearchState, "sortBy" | "sortDir">): AgentSessionsSort {
	return {
		sortBy: search.sortBy ?? DEFAULT_SORT.sortBy,
		sortDir: search.sortDir ?? DEFAULT_SORT.sortDir,
	}
}

/**
 * The URL patch a click on a column header writes. The sorted column flips
 * direction; any other starts descending — the longest, costliest, busiest end
 * of a measure is the one a session list is read for. Landing back on the
 * default order clears both params, so a shared link only carries a sort when
 * one was chosen.
 */
export function agentSessionsSortPatch(
	search: Pick<AgentSessionsSearchState, "sortBy" | "sortDir">,
	key: AiSessionSortKey,
): { sortBy: AiSessionSortKey | undefined; sortDir: AiSessionSortDir | undefined } {
	const current = agentSessionsSort(search)
	const sortDir: AiSessionSortDir = key === current.sortBy && current.sortDir === "desc" ? "asc" : "desc"
	return isDefaultSort({ sortBy: key, sortDir })
		? { sortBy: undefined, sortDir: undefined }
		: { sortBy: key, sortDir }
}

export function hasAgentSessionsFilters(search: AgentSessionsSearchState): boolean {
	return AGENT_SESSIONS_FILTER_KEYS.some((key) => {
		const value = search[key]
		return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false
	})
}

/** A multi-value param, or nothing — an empty array is not a filter. */
const some = (values: ReadonlyArray<string> | undefined) => (values?.length ? values : undefined)

/**
 * Warehouse filter inputs for a given URL state and resolved window.
 *
 * The window is resolved by the caller (it is refresh-aware), and everything
 * else is a rename or a unit change: durations travel in the URL as whole
 * seconds and are filtered in milliseconds.
 */
export function agentSessionsFilterInputs(
	search: AgentSessionsSearchState,
	window: { readonly startTime: string; readonly endTime: string },
): AiSessionsFilterInputs {
	const sort = agentSessionsSort(search)
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		vendorIds: some(search.vendors),
		serviceNames: some(search.services),
		deploymentEnvs: some(search.environments),
		models: some(search.models),
		agentNames: some(search.agents),
		toolNames: some(search.tools),
		search: search.q?.trim() || undefined,
		hasErrors: search.hasErrors === true ? true : undefined,
		excludeTraceSessions: search.grouped === true ? true : undefined,
		durationMinMs: search.durationMin !== undefined ? search.durationMin * 1000 : undefined,
		durationMaxMs: search.durationMax !== undefined ? search.durationMax * 1000 : undefined,
		costMin: search.costMin,
		costMax: search.costMax,
		tokensMin: search.tokensMin,
		tokensMax: search.tokensMax,
		llmCallsMin: search.llmCallsMin,
		llmCallsMax: search.llmCallsMax,
		toolCallsMin: search.toolCallsMin,
		toolCallsMax: search.toolCallsMax,
		// Left off for the default so the first page's SQL stays the baseline shape.
		...(isDefaultSort(sort) ? undefined : sort),
	}
}
