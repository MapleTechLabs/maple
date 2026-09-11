import { useMemo, useState, type ReactNode } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { AI_TOOL_ERRORS_MAX, type AiToolErrorSampleCursor } from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { ToolDetailView } from "@/components/agent-sessions/tools/tool-detail-view"
import {
	ToolErrorModal,
	type ToolErrorDetailData,
	type ToolErrorSamplesState,
} from "@/components/agent-sessions/tools/tool-error-modal"
import { prepareToolErrors, type ToolErrorsWindow } from "@/components/agent-sessions/tools/tool-errors-table"
import { QueryErrorState } from "@/components/common/query-error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { NotFoundError } from "@/components/route-error"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Atom, Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import type { AiToolErrorSamplesInput } from "@/api/warehouse/ai-session-tools"
import {
	TOOL_ANALYTICS_DEFAULT_PRESET,
	ToolAnalyticsSearchFields,
	type ToolAnalyticsSearch,
} from "@/lib/agent-sessions/tool-search"
import type { ToolErrorRow } from "@/lib/agent-sessions/tool-analytics"
import { errorTrendBucket } from "@/lib/agent-sessions/tool-error-display"
import { toolAnalyticsSelection } from "@/lib/agent-sessions/use-tool-analytics"
import {
	aiSessionsFacetsResultAtom,
	aiToolErrorDetailResultAtom,
	aiToolErrorSamplesResultAtom,
	aiToolErrorsResultAtom,
	aiToolSeriesResultAtom,
	aiToolTotalsResultAtom,
	listAiSessionsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"

const toolDetailSearchSchema = Schema.Struct({
	...ToolAnalyticsSearchFields,
	...TimeRangeSearchFields,
})

/** Sessions the detail page lists — the most recent, not the busiest. */
const SESSIONS_LIMIT = 50

/** The only period this page's header states. See the totals atom below. */
const TOOL_DETAIL_TOTALS_PERIODS = ["current"] as const

export const Route = createFileRoute("/agent-sessions/tools/$toolName")({
	component: ToolDetailPage,
	validateSearch: Schema.toStandardSchemaV1(toolDetailSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

/** Behind the `agent_tracing` org rollout flag, gated exactly as the pages
 *  around it: in the component, `isLoaded` first, and no route loader. */
function ToolDetailPage() {
	const { flags, isLoaded } = useOrganizationFeatureFlags()
	if (!isLoaded) return null
	if (!flags.agentTracing) return <NotFoundError />
	return <ToolDetailPageContent />
}

function ToolDetailPageContent() {
	const { toolName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? TOOL_ANALYTICS_DEFAULT_PRESET
	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	// One object for the whole render tree below: it is a dependency of every
	// selection memo down there, and a fresh literal defeats all of them.
	const window = useMemo(() => ({ startTime, endTime }), [startTime, endTime])

	const onSearchChange = (patch: Partial<ToolAnalyticsSearch>) => {
		navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	return (
		<PageRefreshProvider timePreset={preset}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Agent Sessions", href: "/agent-sessions" },
						{ label: "Tools", href: "/agent-sessions/tools" },
						{ label: toolName },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Scroll className="p-0">
							<ToolDetailBody
								tool={toolName}
								search={search}
								window={window}
								onSearchChange={onSearchChange}
								headerControls={
									<TimeRangeHeaderControls
										startTime={search.startTime ?? startTime}
										endTime={search.endTime ?? endTime}
										presetValue={
											search.timePreset ??
											(search.startTime ? undefined : TOOL_ANALYTICS_DEFAULT_PRESET)
										}
										onTimeChange={(range) => {
											navigate({
												search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
											})
										}}
									/>
								}
							/>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

/**
 * The page's reads, resolved.
 *
 * The **totals** read is the one the page waits on — it is what the header
 * says. The charts degrade to empty under a header that is already drawn; the
 * Errors table and the sessions panel do NOT, because "no failed calls" and "no
 * sessions" are findings, and a panel that states one while its read is still
 * in flight (or has failed) is stating something it does not know.
 *
 * The tool is pinned into the selection here rather than being taken from the
 * search params: this page IS that tool, and a `?tool=` carried in from the
 * overview would otherwise be able to disagree with the route.
 */
function ToolDetailBody({
	tool,
	search,
	window,
	onSearchChange,
	headerControls,
}: {
	tool: string
	search: ToolAnalyticsSearch
	window: { startTime: string; endTime: string }
	onSearchChange: (patch: Partial<ToolAnalyticsSearch>) => void
	headerControls: ReactNode
}) {
	// Memoized like the overview's: it is the cache key of five atoms, and a
	// fresh object each render re-subscribes all of them. No name search: this
	// page has no box for one, and a `?q=` would filter the tool's own name out.
	const selection = useMemo(
		() => ({ ...toolAnalyticsSelection(search, window), tool, search: undefined }),
		[search, window, tool],
	)
	const range = useMemo<ToolErrorsWindow>(
		() => ({ startMs: toEpochMs(window.startTime), endMs: toEpochMs(window.endTime) }),
		[window],
	)
	const bucketSeconds = chartBucketSeconds(window.startTime, window.endTime)

	// `split: "none"` — this page is one tool, so the server merges every key
	// inside the query. Letting it split by model and merging here would sum
	// sessions across models and average their quantiles.
	const series = useRefreshableAtomValue(
		aiToolSeriesResultAtom({ data: { ...selection, bucketSeconds, split: "none" as const } }),
	)
	// `periods: ["current"]` — this page's header states the window and nothing
	// else. It draws no delta tiles and no all-sessions share, and each period the
	// totals read measures is its own scan of the window.
	const totals = useRefreshableAtomValue(
		aiToolTotalsResultAtom({ data: { ...selection, periods: TOOL_DETAIL_TOTALS_PERIODS } }),
	)
	// Every group up to the contract's cap: the table folds its own long tail,
	// and a tool with more distinct failures than that has a different problem.
	const errors = useRefreshableAtomValue(
		aiToolErrorsResultAtom({
			data: {
				...selection,
				bucketSeconds: errorTrendBucket(range.startMs, range.endMs).seconds,
				limit: AI_TOOL_ERRORS_MAX,
			},
		}),
	)
	// The sessions that ran this tool, from the list read the sessions page uses
	// — the row's framework, extent and span counts are the list's answers, and
	// a tool-shaped aggregate knows none of them.
	const sessions = useRefreshableAtomValue(
		listAiSessionsResultAtom({
			data: {
				startTime: window.startTime,
				endTime: window.endTime,
				toolNames: [tool],
				...(selection.service !== undefined && { serviceNames: [selection.service] }),
				...(selection.env !== undefined && { deploymentEnvs: [selection.env] }),
				...(selection.model !== undefined && { models: [selection.model] }),
				limit: SESSIONS_LIMIT,
				sortBy: "startTime" as const,
				sortDir: "desc" as const,
			},
		}),
	)
	const facetsResult = useAtomValue(aiSessionsFacetsResultAtom({ data: window }))
	const facets = Result.builder(facetsResult)
		.onSuccess((value) => value)
		.orElse(() => undefined)

	const seriesData = Result.builder(series)
		.onSuccess((value) => value.data)
		.orElse(() => [])
	// Rows, and what state produced them. An empty array from a read that has not
	// answered (or that failed) is not "no failed calls" — the panels say which.
	const errorRows = Result.builder(errors)
		.onSuccess((value) => value.data)
		.orElse((): ReadonlyArray<ToolErrorRow> => [])
	const errorsFailure = Result.builder(errors)
		.onError((failure) => failure as unknown)
		.orElse(() => undefined)
	const sessionRows = Result.builder(sessions)
		.onSuccess((value) => value.data)
		.orElse(() => [])
	const sessionsFailure = Result.builder(sessions)
		.onError((failure) => failure as unknown)
		.orElse(() => undefined)

	// The modal is mounted from the ROW, not from the search param: an `?error=`
	// the window no longer holds must not issue a read for a group that is not on
	// the page.
	const openError =
		search.error === undefined
			? undefined
			: errorRows.find((candidate) => candidate.fingerprint === search.error)

	return Result.builder(totals)
		.onInitial(() => (
			<div className="flex flex-col gap-5 p-6">
				<Skeleton className="h-14 w-full max-w-2xl" />
				<Skeleton className="h-64" />
				<Skeleton className="h-64" />
			</div>
		))
		.onError((error) => (
			<QueryErrorState error={error} titleOverride={`Failed to load ${tool}`} />
		))
		.onSuccess((resolved, result) => (
			<ToolDetailView
				tool={tool}
				search={search}
				onSearchChange={onSearchChange}
				data={{
					series: seriesData,
					totals: resolved.current,
					// The toolbar's predicates narrow this tool's calls; the denominator
					// is the same read without them, which the tool's own totals are
					// only when nothing is set. `scopeSummary` drops the ratio when the
					// two agree, so this is the honest one of the two.
					scopeCalls: resolved.current.calls,
					firstSeen: resolved.firstSeen,
					lastSeen: resolved.lastSeen,
					description: resolved.description,
					range,
					errors: errorRows,
					errorsLoading: Result.isInitial(errors),
					errorsFailure,
					sessions: sessionRows,
					sessionsCapped: sessionRows.length >= SESSIONS_LIMIT,
					sessionsLoading: Result.isInitial(sessions),
					sessionsFailure,
				}}
				serviceOptions={facets?.services ?? []}
				modelOptions={facets?.models ?? []}
				envOptions={facets?.environments ?? []}
				headerControls={headerControls}
				modal={
					openError === undefined ? null : (
						<ErrorModal
							tool={tool}
							rows={errorRows}
							fingerprint={openError.fingerprint}
							range={range}
							toolCalls={resolved.current.calls}
							selection={selection}
							session={search.session}
							variant={search.variant}
							onSearchChange={onSearchChange}
						/>
					)
				}
				waiting={result.waiting}
			/>
		))
		.render()
}

/**
 * The modal's own reads, mounted only once the Errors table holds the row the
 * URL names — so the page never pays for the samples of a group nobody opened,
 * nor for one a stale link names that this window no longer has.
 */
function ErrorModal({
	tool,
	rows,
	fingerprint,
	range,
	toolCalls,
	selection,
	session,
	variant,
	onSearchChange,
}: {
	tool: string
	rows: ReadonlyArray<ToolErrorRow>
	fingerprint: string
	range: ToolErrorsWindow
	toolCalls: number
	selection: ReturnType<typeof toolAnalyticsSelection> & { tool: string }
	session: string | undefined
	variant: string | undefined
	onSearchChange: (patch: Partial<ToolAnalyticsSearch>) => void
}) {
	const prepared = useMemo(() => prepareToolErrors(rows, range), [rows, range])
	const index = prepared.rows.findIndex((row) => row.fingerprint === fingerprint)
	const group = prepared.rows[index]!
	const detail = useRefreshableAtomValue(
		aiToolErrorDetailResultAtom({ data: { ...selection, fingerprint } }),
	)
	const samplesInput = useMemo(
		() => ({
			...selection,
			fingerprint,
			...(session !== undefined && { session }),
			...(variant !== undefined && { variant }),
		}),
		[selection, fingerprint, session, variant],
	)
	const samples = useErrorSamples(samplesInput)

	return (
		<ToolErrorModal
			tool={tool}
			group={group}
			position={{ index, total: prepared.rows.length }}
			// The header and every count come from the row the reader clicked, so
			// the modal opens complete and its rail fills in.
			detail={Result.builder(detail)
				.onSuccess((value) => value)
				.orElse(() => EMPTY_DETAIL)}
			detailLoading={Result.isInitial(detail)}
			detailFailure={Result.builder(detail)
				.onError((failure) => failure as unknown)
				.orElse(() => undefined)}
			samples={samples}
			toolFailures={rows.reduce((sum, row) => sum + row.calls, 0)}
			toolCalls={toolCalls}
			range={range}
			session={session}
			onSelectSession={(next) => onSearchChange({ session: next })}
			variant={variant}
			onSelectVariant={(next) => onSearchChange({ variant: next })}
			onStep={(offset) => {
				const next = prepared.rows[index + offset]
				if (next !== undefined) onSearchChange({ error: next.fingerprint, session: undefined, variant: undefined })
			}}
			onClose={() => onSearchChange({ error: undefined, session: undefined, variant: undefined })}
		/>
	)
}

const EMPTY_DETAIL: ToolErrorDetailData = { sessions: [], variants: [], breakdown: [] }

const NO_CURSORS: ReadonlyArray<AiToolErrorSampleCursor> = []

/**
 * A group's samples, a page at a time, as the cursors that fetched them.
 *
 * Keyed by the narrowing they extend: a different session or variant is a new
 * list, and the old pages must not be appended to it. Each page is its own
 * query atom — and its own bounded payload read — so loading more never
 * re-reads what is already on screen.
 */
function useErrorSamples(data: AiToolErrorSamplesInput): ToolErrorSamplesState {
	const key = JSON.stringify(data)
	const [loaded, setLoaded] = useState<{ key: string; cursors: ReadonlyArray<AiToolErrorSampleCursor> }>({
		key,
		cursors: NO_CURSORS,
	})
	const cursors = loaded.key === key ? loaded.cursors : NO_CURSORS

	const pageAtoms = useMemo(
		() =>
			[undefined, ...cursors].map((before) =>
				aiToolErrorSamplesResultAtom({ data: before === undefined ? data : { ...data, before } }),
			),
		[data, cursors],
	)
	// One subscription over every open page, however many there are.
	const pagesAtom = useMemo(() => Atom.make((get) => pageAtoms.map((atom) => get(atom))), [pageAtoms])
	const pages = useAtomValue(pagesAtom)
	const retryLastPage = useAtomRefresh(pageAtoms[pageAtoms.length - 1]!)

	const first = pages[0]!
	const last = pages[pages.length - 1]!
	const nextCursor = Result.isSuccess(last) ? last.value.nextCursor : undefined
	const loadingMore = pages.length > 1 && Result.isInitial(last)
	const failedMore = pages.length > 1 && Result.isFailure(last)
	const occurrences = useMemo(
		() => pages.flatMap((page) => (Result.isSuccess(page) ? page.value.occurrences : [])),
		[pages],
	)

	return {
		occurrences,
		loading: Result.isInitial(first),
		failure: Result.builder(first)
			.onError((failure) => failure as unknown)
			.orElse(() => undefined),
		paging: failedMore ? "failed" : loadingMore ? "loading" : nextCursor !== undefined ? "more" : "end",
		onLoadMore: () => {
			if (failedMore) {
				retryLastPage()
				return
			}
			if (nextCursor === undefined || loadingMore) return
			setLoaded({ key, cursors: [...cursors, nextCursor] })
		},
	}
}
