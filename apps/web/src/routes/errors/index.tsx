import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import {
	IsoDateTimeString,
	type ErrorIssueDocument,
	type WorkflowState,
} from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { IssuesList } from "@/components/errors/issues-list"
import {
	IssuesFilterSidebar,
	type IssuesFacets,
} from "@/components/errors/issues-filter-sidebar"
import { useIssueMutations } from "@/components/errors/use-issue-mutations"
import { FilterSidebarLoading } from "@/components/filters/filter-sidebar"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

/**
 * The most-recently-seen issues we pull in one request. Facets and multi-select
 * filtering happen client-side over this set (the API only supports single-value
 * filters), so this also bounds memory/render cost. When the cap is hit we tell
 * the user older issues were dropped rather than silently truncating.
 */
const ISSUES_FETCH_LIMIT = 200

/**
 * Issues are a triage backlog, not a live event stream — an open issue that went
 * quiet shouldn't drop off the page. Default to a wide last-seen window so the
 * backlog is visible out of the box; the picker still narrows it.
 */
const DEFAULT_TIME_PRESET = "1mo"

const errorsSearchSchema = Schema.Struct({
	workflowState: OptionalStringArrayParam,
	severity: OptionalStringArrayParam,
	kind: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	incidentOnly: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	includeArchived: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export type ErrorsSearchParams = Schema.Schema.Type<typeof errorsSearchSchema>

export const Route = effectRoute(createFileRoute("/errors/"))({
	component: ErrorsPage,
	validateSearch: Schema.toStandardSchemaV1(errorsSearchSchema),
})

const toIsoDateTime = Schema.decodeSync(IsoDateTimeString)

const WORKFLOW_FACET_ORDER: ReadonlyArray<WorkflowState> = [
	"triage",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"cancelled",
	"wontfix",
]
const SEVERITY_FACET_ORDER = ["critical", "high", "medium", "low", "unset"] as const
const KIND_FACET_ORDER = ["error", "alert"] as const

function severityKey(issue: ErrorIssueDocument): string {
	return issue.severity ?? "unset"
}

function bump(counts: Map<string, number>, key: string) {
	counts.set(key, (counts.get(key) ?? 0) + 1)
}

function orderedOptions(counts: Map<string, number>, order: ReadonlyArray<string>) {
	return order.flatMap((name) => {
		const count = counts.get(name)
		return count ? [{ name, count }] : []
	})
}

function countSortedOptions(counts: Map<string, number>) {
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function buildFacets(issues: ReadonlyArray<ErrorIssueDocument>): IssuesFacets {
	const states = new Map<string, number>()
	const severities = new Map<string, number>()
	const kinds = new Map<string, number>()
	const services = new Map<string, number>()
	for (const issue of issues) {
		bump(states, issue.workflowState)
		bump(severities, severityKey(issue))
		bump(kinds, issue.kind)
		bump(services, issue.serviceName)
	}
	return {
		workflowState: orderedOptions(states, WORKFLOW_FACET_ORDER),
		severity: orderedOptions(severities, SEVERITY_FACET_ORDER),
		kind: orderedOptions(kinds, KIND_FACET_ORDER),
		services: countSortedOptions(services),
	}
}

function toSet(values: ReadonlyArray<string> | undefined): ReadonlySet<string> | undefined {
	return values && values.length > 0 ? new Set(values) : undefined
}

function applyClientFilters(
	issues: ReadonlyArray<ErrorIssueDocument>,
	search: ErrorsSearchParams,
): ReadonlyArray<ErrorIssueDocument> {
	const stateSet = toSet(search.workflowState)
	const severitySet = toSet(search.severity)
	const kindSet = toSet(search.kind)
	const serviceSet = toSet(search.services)
	const incidentOnly = search.incidentOnly === true
	if (!stateSet && !severitySet && !kindSet && !serviceSet && !incidentOnly) return issues
	return issues.filter(
		(issue) =>
			(!stateSet || stateSet.has(issue.workflowState)) &&
			(!severitySet || severitySet.has(severityKey(issue))) &&
			(!kindSet || kindSet.has(issue.kind)) &&
			(!serviceSet || serviceSet.has(issue.serviceName)) &&
			(!incidentOnly || issue.hasOpenIncident),
	)
}

const BREADCRUMBS = [{ label: "Errors" }]
const PAGE_TITLE = "Errors"
const PAGE_DESCRIPTION = "Errors grouped into triage, in-progress, and resolved work."

function ErrorsPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_TIME_PRESET}>
			<ErrorsContent />
		</PageRefreshProvider>
	)
}

function ErrorsContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_TIME_PRESET,
	)

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const issuesResult = useAtomValue(
		MapleApiAtomClient.query("errors", "listIssues", {
			query: {
				startTime: toIsoDateTime(effectiveStartTime),
				endTime: toIsoDateTime(effectiveEndTime),
				includeArchived: search.includeArchived ? "1" : "0",
				limit: ISSUES_FETCH_LIMIT,
			},
			reactivityKeys: ["errorIssues"],
		}),
	)
	const mutations = useIssueMutations()

	const headerActions = (
		<TimeRangeHeaderControls
			startTime={search.startTime}
			endTime={search.endTime}
			presetValue={search.timePreset ?? DEFAULT_TIME_PRESET}
			onTimeChange={handleTimeChange}
		/>
	)

	return Result.builder(issuesResult)
		.onInitial(() => (
			<DashboardLayout
				breadcrumbs={BREADCRUMBS}
				title={PAGE_TITLE}
				description={PAGE_DESCRIPTION}
				filterSidebar={<FilterSidebarLoading sectionCount={4} />}
				headerActions={headerActions}
			>
				<div className="space-y-px p-2">
					{Array.from({ length: 6 }).map((_, i) => (
						<Skeleton key={i} className="h-9 w-full" />
					))}
				</div>
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout
				breadcrumbs={BREADCRUMBS}
				title={PAGE_TITLE}
				description={PAGE_DESCRIPTION}
				headerActions={headerActions}
			>
				<div className="p-4">
					<Empty>
						<EmptyHeader>
							<EmptyTitle>Failed to load issues</EmptyTitle>
							<EmptyDescription>
								{error.message ?? "Try refreshing or check API logs."}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</div>
			</DashboardLayout>
		))
		.onSuccess((response, result) => {
			const issues = response.issues
			const facets = buildFacets(issues)
			const visible = applyClientFilters(issues, search)
			const isFiltered = visible.length !== issues.length
			const capReached = issues.length >= ISSUES_FETCH_LIMIT

			return (
				<DashboardLayout
					breadcrumbs={BREADCRUMBS}
					title={PAGE_TITLE}
					description={PAGE_DESCRIPTION}
					filterSidebar={<IssuesFilterSidebar facets={facets} isRefreshing={result.waiting} />}
					headerActions={headerActions}
				>
					<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
						<span className="tabular-nums text-foreground">
							<span className="font-medium">{visible.length}</span>
							{isFiltered ? ` of ${issues.length}` : ""}{" "}
							{visible.length === 1 && !isFiltered ? "issue" : "issues"}
						</span>
						{capReached ? (
							<span className="ml-auto text-right text-muted-foreground/80">
								Showing the {ISSUES_FETCH_LIMIT} most recently seen — narrow the time range
								for older issues.
							</span>
						) : null}
					</div>
					<IssuesList
						issues={visible}
						mutations={mutations}
						isRefreshing={result.waiting}
						emptyState={
							<Empty>
								<EmptyHeader>
									<EmptyTitle>No issues</EmptyTitle>
									<EmptyDescription>
										{issues.length === 0
											? "No issues in the selected time range."
											: "No issues match the current filters."}
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						}
					/>
				</DashboardLayout>
			)
		})
		.render()
}
