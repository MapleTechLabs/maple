import { useCallback, useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { AiSessionSortDir, AiSessionSortKey } from "@maple/domain/http"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { AgentSessionsList, AgentSessionsListSkeleton } from "@/components/agent-sessions/agent-sessions-list"
import { AgentSessionsFilterSidebar } from "@/components/agent-sessions/agent-sessions-filter-sidebar"
import { AgentSessionsToolbar } from "@/components/agent-sessions/agent-sessions-toolbar"
import { AgentSessionsTabs } from "@/components/agent-sessions/tools/agent-sessions-tabs"
import {
	agentSessionsFilterInputs,
	agentSessionsSort,
	agentSessionsSortPatch,
	hasAgentSessionsFilters,
} from "@/components/agent-sessions/agent-sessions-filter-inputs"
import {
	PageRefreshProvider,
	usePageRefreshContext,
} from "@/components/time-range-picker/page-refresh-context"
import { ReloadControls } from "@/components/time-range-picker/reload-controls"
import { ErrorState } from "@/components/common/error-state"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { BooleanFromStringParam, NumberFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import {
	aiSessionsDistributionsResultAtom,
	aiSessionsFacetsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { resolveEffectiveTimeRange, useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useInfiniteAiSessions } from "@/hooks/use-infinite-ai-sessions"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { useAgentSessionsTabCounts } from "@/lib/agent-sessions/use-tool-analytics"

/**
 * The list's window. There is no picker: sessions are read newest-first over
 * the last week and paged from there, and the sidebar counts the same week.
 * A wider window would only move the point the infinite scroll ends at, and
 * the counted filters have to describe the population the list pages — see
 * `aiSessionFacetsQuery`.
 */
export const AGENT_SESSIONS_WINDOW = "7d"

const BooleanParam = Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam]))
const NumberParam = Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam]))

const agentSessionsSearchSchema = Schema.Struct({
	/** Vendor ids as stamped by the gateway (e.g. `eve`), not display labels. */
	vendors: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	models: OptionalStringArrayParam,
	agents: OptionalStringArrayParam,
	tools: OptionalStringArrayParam,
	/** Session or trace id prefix. */
	q: Schema.optional(Schema.String),
	hasErrors: BooleanParam,
	/** Hide the `trace:` sessions — traces whose vendor exposes no session key. */
	grouped: BooleanParam,
	/** Seconds, like the replays list. */
	durationMin: NumberParam,
	durationMax: NumberParam,
	costMin: NumberParam,
	costMax: NumberParam,
	tokensMin: NumberParam,
	tokensMax: NumberParam,
	llmCallsMin: NumberParam,
	llmCallsMax: NumberParam,
	toolCallsMin: NumberParam,
	toolCallsMax: NumberParam,
	sortBy: Schema.optional(AiSessionSortKey),
	sortDir: Schema.optional(AiSessionSortDir),
})

export const Route = createFileRoute("/agent-sessions/")({
	component: AgentSessionsPage,
	validateSearch: Schema.toStandardSchemaV1(agentSessionsSearchSchema),
})

function AgentSessionsPage() {
	return (
		<PageRefreshProvider>
			<AgentSessionsBody />
		</PageRefreshProvider>
	)
}

/** The filter rail and the list, so both share one resolved window. */
function AgentSessionsBody() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	// Memoized on the search by VALUE, not by the reference the router hands
	// back: the hook keys its accumulated pages on these inputs, and a fresh
	// object per render would reset them every time.
	const searchKey = JSON.stringify(search)
	const { refreshVersion } = usePageRefreshContext()
	// Resolved in the selected zone, as `useEffectiveTimeRange` does on the Tools
	// tab: `7d` starts at that zone's midnight.
	const { effectiveTimezone } = useTimezonePreference()
	// "The last week" resolves against now once per mount and once per Reload,
	// never snapped: the list is newest-first, and an end floored to the cache
	// grid hid up to a grid interval of the newest sessions on every page load.
	// A filter or sort change keeps the window rather than re-resolving it, which
	// is what holds the unfiltered facets' and distributions' keys steady — the
	// job the snap used to do.
	const { startTime, endTime } = useMemo(
		() =>
			resolveEffectiveTimeRange(undefined, undefined, AGENT_SESSIONS_WINDOW, {
				snap: false,
				timeZone: effectiveTimezone,
			}),
		[refreshVersion, effectiveTimezone],
	)
	const filterInputs = useMemo(
		() => agentSessionsFilterInputs(search, { startTime, endTime }),
		[searchKey, startTime, endTime],
	)
	const { firstPageResult, allData, hasNextPage, isCapped, isFetchingNextPage, fetchNextPage } =
		useInfiniteAiSessions(filterInputs)
	// The sidebar's counts come from the UNFILTERED window, so picking a vendor
	// doesn't erase the others from the list. Plain useAtomValue keeps this off
	// the Reload subscription — the facets refetch when the window rolls, which
	// is enough.
	const facetsResult = useAtomValue(aiSessionsFacetsResultAtom({ data: { startTime, endTime } }))
	// The ranges' histograms, over the same unfiltered window — a request of its
	// own, because it nets every session's usage and the facets need not wait.
	const distributionsResult = useAtomValue(
		aiSessionsDistributionsResultAtom({ data: { startTime, endTime } }),
	)
	const sessions = allData
	// Both tabs' counts over this week, unfiltered — over the Tools tab's own
	// resolution of its default window (snapped, unlike the list's), so the reads
	// are the ones it makes: the numbers match there and survive the switch.
	const tabCountsWindow = useEffectiveTimeRange(undefined, undefined, AGENT_SESSIONS_WINDOW)
	const tabCounts = useAgentSessionsTabCounts(tabCountsWindow)
	const { sortBy, sortDir } = agentSessionsSort(search)
	const onSortChange = useCallback(
		(key: AiSessionSortKey) =>
			navigate({ search: (prev) => ({ ...prev, ...agentSessionsSortPatch(prev, key) }) }),
		[navigate],
	)

	// The filter keys only: anything else riding in the URL (a dev flag, a stale param) is not a
	// question the user asked, and reading it as one swaps the setup on-ramp for "clear filters".
	const hasActiveFilters = hasAgentSessionsFilters(search)
	const handleClearFilters = () =>
		navigate({ search: (prev) => ({ sortBy: prev.sortBy, sortDir: prev.sortDir }) })

	const toolbar = (
		<AgentSessionsToolbar
			// Held back until the first page lands, so the count never reads zero
			// above a list that is about to fill.
			sessionCount={Result.isSuccess(firstPageResult) ? sessions.length : undefined}
			query={search.q ?? ""}
			onSearch={(value) => navigate({ search: (prev) => ({ ...prev, q: value }) })}
			errorsOnly={search.hasErrors === true}
			onToggleErrorsOnly={() =>
				navigate({
					search: (prev) => ({
						...prev,
						hasErrors: prev.hasErrors ? undefined : true,
					}),
				})
			}
			waiting={firstPageResult.waiting}
			actions={<ReloadControls />}
		/>
	)

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Agent Sessions" }]}
			filters={
				<AgentSessionsFilterSidebar
					facetsResult={facetsResult}
					distributionsResult={distributionsResult}
				/>
			}
			// The Tools tab reads the same spans across every session; this page reads one
			// session at a time. Two routes, one strip, laid out identically on both.
			tabs={
				<AgentSessionsTabs active="sessions" counts={tabCounts} className="border-b border-border" />
			}
			sticky={toolbar}
			// The sticky area's own bottom padding already separates the toolbar from the table.
			scrollClassName="pt-0"
		>
			{Result.builder(firstPageResult)
				.onInitial(() => <AgentSessionsListSkeleton />)
				.onError((error) => <ErrorState error={error} title="Failed to load agent sessions" />)
				.onSuccess(() => (
					<AgentSessionsList
						sessions={allData}
						sortBy={sortBy}
						sortDir={sortDir}
						onSortChange={onSortChange}
						hasMore={hasNextPage}
						isCapped={isCapped}
						loadingMore={isFetchingNextPage}
						onReachEnd={fetchNextPage}
						filtered={hasActiveFilters}
						onClearFilters={handleClearFilters}
					/>
				))
				.render()}
		</DashboardPage>
	)
}
