import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import type { CiRunResult } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { CiAnalyticsSkeleton, CiAnalyticsView } from "@/components/code-review/ci/ci-analytics"
import { CI_RESULT_LABELS, isCiRunResult, windowWasCut } from "@/components/code-review/ci/ci-format"
import { CiRunsList } from "@/components/code-review/ci/ci-runs-list"
import {
	CodeReviewCiFilters,
	CodeReviewLayout,
	NothingInWindow,
} from "@/components/code-review/code-review-layout"
import {
	CODE_REVIEW_CI_DEFAULT_PRESET,
	CodeReviewCiSearchFields,
	type CodeReviewSearch,
} from "@/components/code-review/code-review-search"
import { ResultView } from "@/components/common/result-view"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { SectionHeading } from "@/components/common/section-heading"
import { XmarkIcon } from "@/components/icons"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

const searchSchema = Schema.Struct(CodeReviewCiSearchFields)

export const Route = createFileRoute("/code-review/ci")({
	component: CodeReviewCiPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

type CiPatch = Partial<CodeReviewSearch> & {
	timePreset?: string
	pipeline?: string
	branch?: string
	result?: CiRunResult
}

const RESULT_ITEMS = { all: "All results", ...CI_RESULT_LABELS }

/** Above the page, so the header's reload re-resolves the window the page reads. */
function CodeReviewCiPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? CODE_REVIEW_CI_DEFAULT_PRESET}>
			<CodeReviewCiPageContent />
		</PageRefreshProvider>
	)
}

function CodeReviewCiPageContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { effectiveTimezone } = useTimezonePreference()
	const preset = search.timePreset ?? CODE_REVIEW_CI_DEFAULT_PRESET
	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	// The resolved window, shared by the page's queries and the filters' workflow list.
	const window = { startTime: toEpochMs(startTime), endTime: toEpochMs(endTime) }

	const query = retainedInternalQuery("codeReview", "ciAnalytics", {
		query: { ...window, repositoryId: search.repo, pipeline: search.pipeline },
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)

	const onChange = (patch: CiPatch) => void navigate({ search: (prev) => ({ ...prev, ...patch }) })
	const filtered = search.repo !== undefined || search.pipeline !== undefined
	// The on-ramp is for orgs without CI traces; a connected one with a quiet window just widens it.
	const githubStatus = useAtomValue(
		retainedInternalQuery("integrations", "githubStatus", {
			reactivityKeys: ["githubIntegrationStatus"],
		}),
	)
	const ciTracesOn = Result.builder(githubStatus)
		.onSuccess((status) => status.connected && status.ciTracesEnabled)
		.orElse(() => false)
	const runsFilter = {
		...window,
		repositoryId: search.repo,
		pipeline: search.pipeline,
		branch: search.branch,
		result: search.result,
	}

	return (
		<CodeReviewLayout
			active="ci"
			search={search}
			toolbar={
				<CodeReviewCiFilters
					search={search}
					pipeline={search.pipeline}
					window={window}
					onChange={onChange}
				/>
			}
		>
			<ResultView
				result={result}
				loading={<CiAnalyticsSkeleton />}
				errorTitle="Failed to load CI analytics"
				onRetry={refresh}
				isEmpty={(analytics) => analytics.current.runs === 0 && analytics.pipelines.length === 0}
				empty={
					filtered || ciTracesOn ? (
						<NothingInWindow
							title="No CI runs in this window"
							description={
								filtered
									? "Nothing matches these filters. Widen the window or clear the filters."
									: "No GitHub Actions run finished in this window. Widen the window."
							}
							onClear={
								filtered
									? () => onChange({ repo: undefined, pipeline: undefined })
									: undefined
							}
						/>
					) : (
						<NoCiRuns />
					)
				}
			>
				{(analytics) => {
					const cut = windowWasCut(window.startTime, analytics.startTime)
					return (
						<div className="flex flex-col gap-6">
							{cut ? (
								<p className="text-sm text-muted-foreground">
									CI analytics cover at most 14 days: showing runs since{" "}
									{formatTimestampInTimezone(new Date(analytics.startTime), {
										timeZone: effectiveTimezone,
										style: "range",
									})}
									.
								</p>
							) : null}
							<CiAnalyticsView
								analytics={analytics}
								windowLabel={cut || search.startTime ? "period" : preset}
								pipeline={search.pipeline}
								onSelectPipeline={(pipeline) => onChange({ pipeline })}
							/>
							<section className="flex flex-col gap-3">
								<SectionHeading
									title="Runs"
									as="h2"
									actions={
										<div className="flex flex-wrap items-center gap-2">
											{search.branch ? (
												<Button
													variant="outline"
													size="sm"
													onClick={() => onChange({ branch: undefined })}
													aria-label={`Clear branch ${search.branch}`}
												>
													<span className="max-w-40 truncate font-mono">
														{search.branch}
													</span>
													<XmarkIcon aria-hidden />
												</Button>
											) : null}
											<Select
												items={RESULT_ITEMS}
												value={search.result ?? "all"}
												onValueChange={(value) =>
													onChange({
														result: isCiRunResult(value) ? value : undefined,
													})
												}
											>
												<SelectTrigger size="sm" className="w-36" aria-label="Result">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{Object.entries(RESULT_ITEMS).map(([value, label]) => (
														<SelectItem key={value} value={value}>
															{label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									}
								/>
								<CiRunsList
									key={JSON.stringify(runsFilter)}
									filter={runsFilter}
									onBranch={(branch) => onChange({ branch })}
									onClear={
										search.branch !== undefined || search.result !== undefined
											? () => onChange({ branch: undefined, result: undefined })
											: undefined
									}
								/>
							</section>
						</div>
					)
				}}
			</ResultView>
		</CodeReviewLayout>
	)
}

function NoCiRuns() {
	return (
		<Empty className="rounded-md border border-dashed md:py-14">
			<EmptyHeader>
				<EmptyTitle>No CI runs yet</EmptyTitle>
				<EmptyDescription>
					CI runs come from the GitHub integration: with CI traces on, every GitHub Actions run of a
					connected repository becomes a trace, and its workflows, jobs and failures show up here.
				</EmptyDescription>
			</EmptyHeader>
			<Button
				variant="outline"
				size="sm"
				render={<Link to="/integrations" search={{ integration: "github" }} />}
			>
				Open the GitHub integration
			</Button>
		</Empty>
	)
}
