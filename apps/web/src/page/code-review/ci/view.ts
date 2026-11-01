import type { CodeReviewCiAnalytics } from "@maple/domain/http"
import { CI_RESULT_LABELS } from "../../../components/code-review/ci/ci-format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { AREA_CHART_TOKENS } from "../../../charts/area-chart"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import type * as Select from "../../../ui/select"
import { type SelectEntry, view as selectView } from "../../../ui/select-view"
import type { PageViewInputs } from "../../contract"
import { seriesTokens } from "../kit/analytics-panel"
import { filtersView } from "../kit/filters-view"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { nothingInWindow } from "../../kit/nothing-in-window"
import { codeReviewLayout } from "../kit/layout"
import { sectionHeading } from "../../kit/section-heading"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { runsList } from "./view-runs"
import { ciSkeleton } from "../kit/skeletons"
import { chartsRow, headlineStrip, RESULT_SERIES } from "./view-stats"
import { jobsTable, workflowsTable } from "./view-tables"

// `CodeReviewCiPage` and `CiAnalyticsView`.

type H = HtmlBuilder<Message>

const THEME_TOKENS = [...seriesTokens([...Object.values(RESULT_SERIES), "p50", "p95"]), ...AREA_CHART_TOKENS]

const RESULT_ENTRIES: ReadonlyArray<SelectEntry> = Object.entries({
	all: "All results",
	...CI_RESULT_LABELS,
}).map(([value, label]) => ({ _tag: "Item", item: { value, label } }))

/** The on-ramp for an org without CI traces. */
const noCiRuns = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyTitle(h, ["No CI runs yet"]),
				emptyDescription(h, [
					"CI runs come from the GitHub integration: with CI traces on, every GitHub Actions run of a connected repository becomes a trace, and its workflows, jobs and failures show up here.",
				]),
			]),
			linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					href: hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } })),
				},
				["Open the GitHub integration"],
			),
		],
		"rounded-md border border-dashed md:py-14",
	)

const runsActions = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			...(model.search.branch
				? [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								attributes: [
									h.OnClick(Message.ClickedClearBranch()),
									h.AriaLabel(`Clear branch ${model.search.branch}`),
								],
							},
							[
								h.span([h.Class("max-w-40 truncate font-mono")], [model.search.branch]),
								icon(h, "XmarkIcon"),
							],
						),
					]
				: []),
			h.submodel({
				slotId: model.resultSelect.id,
				model: model.resultSelect,
				view: selectView,
				toParentMessage: (message: Select.Message) => Message.GotResultSelectMessage({ message }),
				viewInputs: {
					entries: RESULT_ENTRIES,
					size: "sm",
					ariaLabel: "Result",
					className: "w-36",
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
			}),
		],
	)

const analyticsView = (h: H, model: Model, analytics: CodeReviewCiAnalytics, timeZone: string): Html => {
	const windowLabel =
		model.search.startTime !== undefined ? "period" : (model.search.timePreset ?? DEFAULT_PRESET)
	const theme = model.themeColors
	const time = { nowMs: model.frame.nowMs, timeZone }
	if (theme === null || !isChartRuntimeReady(model.chartRuntime)) return ciSkeleton(h)
	return h.div(
		[h.Class("flex flex-col gap-6")],
		[
			h.div(
				[h.Class("flex flex-col gap-6")],
				[
					headlineStrip(h, analytics.current, analytics.previous, windowLabel),
					chartsRow(h, model, analytics, { theme, ...time }),
					workflowsTable(h, analytics.pipelines, model.search.pipeline, time),
					jobsTable(h, analytics.jobs),
				],
			),
			h.section(
				[h.Class("flex flex-col gap-3")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center justify-between gap-x-3 gap-y-2")],
						[sectionHeading(h, { title: "Runs" }), runsActions(h, model)],
					),
					runsList(
						h,
						model,
						time,
						model.search.branch !== undefined || model.search.result !== undefined,
					),
				],
			),
		],
	)
}

const ciTracesOn = (model: Model) =>
	Option.match(AsyncData.getData(model.frame.githubStatus.data), {
		onNone: () => false,
		onSome: (status) => status.connected && status.ciTracesEnabled,
	})

const content = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.analytics.data, {
		onEmpty: () => ciSkeleton(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load CI analytics",
				onRetry: Message.ClickedRetry(),
			}),
		onData: (analytics) => {
			if (analytics.current.runs !== 0 || analytics.pipelines.length !== 0)
				return analyticsView(h, model, analytics, timeZone)
			const filtered = model.search.repo !== undefined || model.search.pipeline !== undefined
			if (!filtered && !ciTracesOn(model)) return noCiRuns(h)
			return nothingInWindow(h, {
				title: "No CI runs in this window",
				description: filtered
					? "Nothing matches these filters. Widen the window or clear the filters."
					: "No GitHub Actions run finished in this window. Widen the window.",
				onClear: filtered ? Message.ClickedClearFilters() : undefined,
			})
		},
	})

const pipelinesOf = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.pipelines.data), {
		onNone: () => [],
		onSome: (analytics) => [...new Set(analytics.pipelines.map((row) => row.pipeline))].toSorted(),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const filters = filtersView(h, {
		frame: model.frame,
		search: model.search,
		reviewedOnly: false,
		kind: "workflow",
		options: pipelinesOf(model),
		selected: model.search.pipeline,
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
					active: "ci",
					search: model.search,
					toolbar: filters.actions,
					filters: filters.filters,
				},
				[content(h, model, inputs.context.timeZone)],
			),
		],
	)
})
