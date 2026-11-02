import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { empty, emptyDescription, emptyFrameClass, emptyHeader, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import type { PageViewInputs } from "../../contract"
import { filteredEmpty } from "../../kit/signal-empty-state"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { seriesTokens } from "../kit/analytics-panel"
import { filtersView } from "../kit/filters-view"
import { codeReviewLayout } from "../kit/layout"
import { analyticsSkeleton } from "../kit/skeletons"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { presetSpanLabel } from "../../kit/time-controls"
import { issuesCard, SEVERITY_SERIES, volumeCard } from "./view-charts"
import { authorsCard, categoriesCard, outcomesCard } from "./view-lists"
import { headlineStrip, secondaryStats } from "./view-stats"
import { vstack } from "@maple/views/ui/stack"
import { grid } from "@maple/views/ui/grid"

// `CodeReviewAnalyticsPage` and `CodeReviewAnalyticsView`.

type H = HtmlBuilder<Message>

const THEME_TOKENS = seriesTokens(["PRs reviewed", "Reviews", ...Object.values(SEVERITY_SERIES)])

const isFiltered = (model: Model) => model.search.repo !== undefined || model.search.author !== undefined

const content = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.analytics.data, {
		onEmpty: () => analyticsSkeleton(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load review analytics",
				onRetry: Message.ClickedRetry(),
			}),
		onData: (analytics) => {
			if (analytics.current.reviews === 0 && analytics.current.findings === 0) {
				const filtered = isFiltered(model)
				if (filtered)
					return filteredEmpty(h, {
						noun: "reviews",
						description: "Widen the window or clear the filters.",
						onClear: Message.ClickedClearFilters(),
						className: emptyFrameClass("dashed"),
					})
				return empty(
					h,
					[
						emptyHeader(h, [
							emptyTitle(h, ["No reviews in this window"]),
							emptyDescription(h, [
								"Turn on reviews for a repository in Settings, then open a pull request against it.",
							]),
						]),
					],
					emptyFrameClass("dashed"),
				)
			}
			const theme = model.themeColors
			if (theme === null || !isChartRuntimeReady(model.chartRuntime)) return analyticsSkeleton(h)
			const windowLabel =
				model.search.startTime !== undefined
					? "period"
					: presetSpanLabel(model.search.timePreset ?? DEFAULT_PRESET)
			return vstack(h, { gap: "6" }, [
				headlineStrip(h, analytics.current, analytics.previous, windowLabel),
				grid(h, { lg: 2, gap: "6" }, [
					volumeCard(h, model, analytics, theme, timeZone),
					issuesCard(h, model, analytics, theme, timeZone),
				]),
				h.div(
					[h.Class("grid gap-6 lg:grid-cols-3")],
					[
						categoriesCard(h, analytics),
						outcomesCard(h, analytics.current, analytics),
						authorsCard(h, analytics),
					],
				),
				secondaryStats(h, analytics.current),
			])
		},
	})

const authorsOf = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.authors.data), {
		onNone: () => [],
		onSome: (analytics) => analytics.authors.map((row) => row.author),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const filters = filtersView(h, {
		frame: model.frame,
		search: model.search,
		reviewedOnly: true,
		kind: "author",
		options: authorsOf(model),
		selected: model.search.author,
		defaultPreset: DEFAULT_PRESET,
		presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
		toMessage: (message) => Message.GotFrameMessage({ message }),
		isFailed: AsyncData.isFailure(model.analytics.data),
	})
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			codeReviewLayout(
				{
					h,
					active: "analytics",
					search: model.search,
					toolbar: filters.actions,
					filters: filters.filters,
				},
				[content(h, model, inputs.context.timeZone)],
			),
		],
	)
})
