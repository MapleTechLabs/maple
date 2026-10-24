import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { errorState } from "../../../ui/error-state"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { seriesTokens } from "../kit/analytics-panel"
import { filtersView } from "../kit/filters-view"
import { codeReviewLayout, nothingInWindow } from "../kit/layout"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { issuesCard, SEVERITY_SERIES, volumeCard } from "./view-charts"
import { authorsCard, categoriesCard, outcomesCard } from "./view-lists"
import { headlineStrip, secondaryStats } from "./view-stats"

// `CodeReviewAnalyticsPage` and `CodeReviewAnalyticsView`.

type H = HtmlBuilder<Message>

const THEME_TOKENS = seriesTokens(["PRs reviewed", "Reviews", ...Object.values(SEVERITY_SERIES)])

export const loadingSkeleton = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-6")],
		[
			skeleton(h, "h-[118px] w-full rounded-md"),
			h.div(
				[h.Class("grid gap-6 lg:grid-cols-2")],
				[skeleton(h, "h-[440px] w-full rounded-md"), skeleton(h, "h-[440px] w-full rounded-md")],
			),
		],
	)

const isFiltered = (model: Model) => model.search.repo !== undefined || model.search.author !== undefined

const content = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.analytics.data, {
		onEmpty: () => loadingSkeleton(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load review analytics",
				onRetry: Message.ClickedRetry(),
			}),
		onData: (analytics) => {
			if (analytics.current.reviews === 0 && analytics.current.findings === 0) {
				const filtered = isFiltered(model)
				return nothingInWindow(h, {
					title: "No reviews in this window",
					description: filtered
						? "Nothing matches these filters. Widen the window or clear the filters."
						: "Turn on reviews for a repository in Settings, then open a pull request against it.",
					onClear: filtered ? Message.ClickedClearFilters() : undefined,
				})
			}
			const theme = model.themeColors
			if (theme === null || !isChartRuntimeReady(model.chartRuntime)) return loadingSkeleton(h)
			const windowLabel =
				model.search.startTime !== undefined ? "period" : (model.search.timePreset ?? DEFAULT_PRESET)
			return h.div(
				[h.Class("flex flex-col gap-6")],
				[
					headlineStrip(h, analytics.current, analytics.previous, windowLabel),
					h.div(
						[h.Class("grid gap-6 lg:grid-cols-2")],
						[
							volumeCard(h, model, analytics, theme, timeZone),
							issuesCard(h, model, analytics, theme, timeZone),
						],
					),
					h.div(
						[h.Class("grid gap-6 lg:grid-cols-3")],
						[
							categoriesCard(h, analytics),
							outcomesCard(h, analytics.current, analytics),
							authorsCard(h, analytics),
						],
					),
					secondaryStats(h, analytics.current),
				],
			)
		},
	})

const authorsOf = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.authors.data), {
		onNone: () => [],
		onSome: (analytics) => analytics.authors.map((row) => row.author),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			codeReviewLayout(
				{
					h,
					active: "analytics",
					search: model.search,
					toolbar: filtersView(h, {
						frame: model.frame,
						search: model.search,
						reviewedOnly: true,
						kind: "author",
						options: authorsOf(model),
						selected: model.search.author,
						defaultPreset: DEFAULT_PRESET,
						presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
						toMessage: (message) => Message.GotFrameMessage({ message }),
					}),
				},
				[content(h, model, inputs.context.timeZone)],
			),
		],
	),
)
