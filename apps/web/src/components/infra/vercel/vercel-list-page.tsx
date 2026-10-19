// The /infra/vercel list as one presentational page: header with the view pivot, then either the
// projects (band, search, table) or AI Gateway usage. The route fetches and owns the URL; the lab
// renders the same component from fixtures.

import { useMemo, type ReactNode } from "react"
import type {
	VercelAiGatewayBucket,
	VercelAiGatewayResponse,
	VercelInfraProject,
	VercelInfraRequestBucket,
	VercelIntegrationStatus,
} from "@maple/domain/http"
import { ChartLoading } from "@maple/ui/components/charts"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"

import { FilteredEmpty } from "@/components/common/filtered-empty"
import { HeroChip, PageHero } from "@/components/common/page-hero"
import { SearchToolbar, countLabel } from "@/components/common/search-toolbar"
import { StatRailLoading } from "@/components/common/stat-rail"
import { VercelIcon } from "@/components/icons"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { IntegrationNotConnected } from "../primitives/integration-not-connected"
import { SegmentPivot } from "../primitives/segment-pivot"
import { vercelFleetTotals, vercelProjectRows } from "./list-model"
import { VercelAiGatewayEmpty, VercelAiGatewayPanel } from "./vercel-ai-gateway"
import {
	VercelFleetBand,
	VercelFleetBandLoading,
	VercelProjectTable,
	VercelProjectTableLoading,
} from "./vercel-project-table"

export const VERCEL_VIEWS = ["projects", "aiGateway"] as const
export type VercelView = (typeof VERCEL_VIEWS)[number]

export interface VercelListState {
	view?: VercelView
	q?: string
}

export const VERCEL_DESCRIPTION =
	"Requests, cache and errors from Vercel's log drain; latency and AI Gateway usage from its trace drain."

/** Nothing in the window: either nothing is forwarded yet, or the drains have not delivered. */
function NoDataYet({ status }: { status: VercelIntegrationStatus }) {
	const { title, description } = status.logsEnabled
		? {
				title: "Waiting for Vercel's first logs",
				description:
					"The logs drain delivers within a minute of a request reaching a forwarded project. This page updates on its own; a quiet project needs one request.",
			}
		: status.tracesEnabled
			? {
					title: "No deployment traces in this window",
					description:
						"Only traces are forwarded, so projects appear here once they send deployment traces. Turn logs on for the connection to count requests, cache hits and errors.",
				}
			: {
					title: "Nothing is forwarded",
					description: "Turn logs or traces on for the connection to fill this page.",
				}
	return (
		<IntegrationNotConnected
			icon={<VercelIcon size={16} className="text-foreground" />}
			title={title}
			description={description}
			integration="vercel"
			actionLabel="Check the connection"
			actionVariant="outline"
			docsPage="vercel"
		/>
	)
}

export function VercelListPage({
	status,
	projects,
	buckets,
	aiGateway,
	aiTimeseries,
	projectsError,
	bucketsError,
	aiGatewayError,
	state,
	onStateChange,
	timeSearch,
	waiting = false,
}: {
	status: VercelIntegrationStatus
	/** Null while loading. */
	projects: ReadonlyArray<VercelInfraProject> | null
	/** The fleet's request buckets, gaps filled. */
	buckets: ReadonlyArray<VercelInfraRequestBucket>
	/** Null while loading. */
	aiGateway: VercelAiGatewayResponse | null
	/** `aiGateway.timeseries`, gaps filled. */
	aiTimeseries: ReadonlyArray<VercelAiGatewayBucket>
	/** Shown in place of the projects when their read failed. */
	projectsError?: ReactNode
	/** Shown under the fleet band when the request series failed. */
	bucketsError?: ReactNode
	/** Shown in place of AI Gateway usage when its read failed. */
	aiGatewayError?: ReactNode
	state: VercelListState
	onStateChange: (patch: Partial<VercelListState>) => void
	timeSearch: TimeRangeSearch
	waiting?: boolean
}) {
	const view = state.view ?? "projects"
	const rows = useMemo(
		() => (projects === null ? null : vercelProjectRows(status.projects, projects)),
		[status.projects, projects],
	)
	const projectNames = useMemo(
		() => new Map(status.projects.map((project) => [project.id, project.name])),
		[status.projects],
	)

	const projectsBody = (): ReactNode => {
		if (projectsError !== undefined) return projectsError
		if (projects === null || rows === null) {
			return (
				<>
					<VercelFleetBandLoading />
					<VercelProjectTableLoading />
				</>
			)
		}
		if (projects.length === 0) return <NoDataYet status={status} />
		const q = (state.q ?? "").trim().toLowerCase()
		const shown = q
			? rows.filter((row) =>
					`${row.name} ${row.framework ?? ""} ${row.projectId}`.toLowerCase().includes(q),
				)
			: rows
		return (
			<>
				<VercelFleetBand
					totals={vercelFleetTotals(projects)}
					projectCount={projects.length}
					buckets={buckets}
					aiGateway={
						aiGatewayError !== undefined
							? "failed"
							: aiGateway === null
								? null
								: {
										summary: aiGateway.summary,
										spark: aiTimeseries.map((row) => row.costUsd),
									}
					}
					onOpenAiGateway={() => onStateChange({ view: "aiGateway" })}
				/>
				{bucketsError}
				<SearchToolbar
					value={state.q ?? ""}
					onChange={(next) => onStateChange({ q: next || undefined })}
					placeholder="Search projects…"
					trailing={
						shown.length === rows.length
							? countLabel(rows.length, rows.length, "project")
							: `${shown.length} of ${rows.length} projects`
					}
				/>
				{shown.length === 0 ? (
					<FilteredEmpty
						noun="projects"
						description="Clear the search to see them all."
						onClear={() => onStateChange({ q: undefined })}
						clearLabel="Clear search"
					/>
				) : (
					<VercelProjectTable rows={shown} timeSearch={timeSearch} />
				)}
			</>
		)
	}

	const aiGatewayBody = (): ReactNode => {
		if (aiGatewayError !== undefined) return aiGatewayError
		if (aiGateway === null) {
			return (
				<>
					<StatRailLoading count={5} columns={5} />
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						<ChartLoading variant="bar" height={240} />
						<ChartLoading variant="bar" height={240} />
					</div>
				</>
			)
		}
		if (aiGateway.summary.requests === 0) return <VercelAiGatewayEmpty />
		return (
			<VercelAiGatewayPanel
				data={aiGateway}
				timeseries={aiTimeseries}
				projectNames={projectNames}
				timeSearch={timeSearch}
			/>
		)
	}

	return (
		<div className="space-y-6">
			<PageHero
				title="Vercel"
				description={VERCEL_DESCRIPTION}
				trailing={status.team ? <HeroChip>team {status.team.name}</HeroChip> : null}
				actions={
					<SegmentPivot<VercelView>
						ariaLabel="Vercel view"
						options={[
							{
								value: "projects",
								label: rows === null ? "Projects" : `Projects ${rows.length}`,
							},
							{ value: "aiGateway", label: "AI Gateway" },
						]}
						value={view}
						onChange={(next) => onStateChange({ view: next === "projects" ? undefined : next })}
					/>
				}
			/>
			<div className={cn("space-y-4", refreshingClass(waiting))} aria-busy={waiting || undefined}>
				{view === "projects" ? projectsBody() : aiGatewayBody()}
			</div>
		</div>
	)
}
