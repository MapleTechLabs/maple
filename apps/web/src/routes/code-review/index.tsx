import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { toEpochMs } from "@maple/ui/lib/time-format"

import {
	CodeReviewAnalyticsSkeleton,
	CodeReviewAnalyticsView,
} from "@/components/code-review/code-review-analytics"
import {
	CodeReviewFilters,
	CodeReviewLayout,
	NothingInWindow,
} from "@/components/code-review/code-review-layout"
import {
	CODE_REVIEW_DEFAULT_PRESET,
	CodeReviewSearchFields,
	type CodeReviewSearch,
} from "@/components/code-review/code-review-search"
import { ErrorState } from "@/components/common/error-state"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"

const searchSchema = Schema.Struct(CodeReviewSearchFields)

export const Route = createFileRoute("/code-review/")({
	component: CodeReviewAnalyticsPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

function CodeReviewAnalyticsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? CODE_REVIEW_DEFAULT_PRESET
	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	// The resolved window, shared by the page's query and the filters' author list.
	const window = { startTime: toEpochMs(startTime), endTime: toEpochMs(endTime) }

	const query = retainedQuery("codeReview", "analytics", {
		query: {
			...window,
			repositoryId: search.repo,
			author: search.author,
		},
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)

	const onChange = (patch: Partial<CodeReviewSearch>) =>
		navigate({ search: (prev) => ({ ...prev, ...patch }) })
	const filtered = search.repo !== undefined || search.author !== undefined

	return (
		<CodeReviewLayout
			active="analytics"
			search={search}
			toolbar={<CodeReviewFilters search={search} window={window} onChange={onChange} />}
		>
			{Result.builder(result)
				.onInitial(() => <CodeReviewAnalyticsSkeleton />)
				.onError((error) => (
					<ErrorState error={error} title="Failed to load review analytics" onRetry={refresh} />
				))
				.onSuccess((analytics) =>
					analytics.current.reviews === 0 && analytics.current.findings === 0 ? (
						<NothingInWindow
							title="No reviews in this window"
							description={
								filtered
									? "Nothing matches these filters. Widen the window or clear the filters."
									: "Turn on reviews for a repository in Settings, then open a pull request against it."
							}
							onClear={
								filtered ? () => onChange({ repo: undefined, author: undefined }) : undefined
							}
						/>
					) : (
						<CodeReviewAnalyticsView
							analytics={analytics}
							search={search}
							windowLabel={search.startTime ? "period" : preset}
						/>
					),
				)
				.render()}
		</CodeReviewLayout>
	)
}
