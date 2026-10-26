import { AsyncData, Submodel } from "foldkit"
import * as AddToDashboard from "./add-to-dashboard"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AREA_CHART_TOKENS } from "../../../charts/area-chart"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { chartLoading } from "../../../ui/chart-state"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { pageTitle } from "../../../ui/page-layout"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { docsLink } from "../../kit/signal-empty-state"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import type { CatalogSummary } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET, draftOf, summaryOf } from "./update"
import { graduationActions, queryControls } from "./view-controls"
import { metadataPanel, metricBreakdown, metricChart } from "./view-panels"

type H = HtmlBuilder<Message>

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

const actions = (h: H, model: Model): Html =>
	timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: toTimePicker,
				viewInputs: {
					label,
					selectedPreset:
						model.search.timePreset ??
						(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})

const loading = (h: H): Html =>
	h.div(
		[h.Class("space-y-4")],
		[skeleton(h, "h-14 w-full"), chartLoading(h, { variant: "area", height: 320 })],
	)

const noData = (h: H, metricName: string): Html =>
	emptyMessage(h, { dashed: true, className: "flex flex-col items-center p-12" }, [
		h.p([h.Class("font-medium text-foreground")], ["No data for this metric in the selected range"]),
		h.p(
			[h.Class("mt-2 max-w-md")],
			[
				h.span([h.Class("font-mono")], [metricName]),
				" has no datapoints in this window. Widen the time range, or check that the service emitting it is still running.",
			],
		),
		h.span([h.Class("mt-3")], [docsLink(h, "metrics")]),
	])

/** `MetricDetailContent`. */
const content = (h: H, model: Model, summary: CatalogSummary, timeZone: string): Html => {
	const draft = draftOf(model, summary)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			graduationActions(h, model),
			h.submodel({
				slotId: "metric-add-to-dashboard-dialog",
				model: model.addToDashboard,
				view: AddToDashboard.view,
				viewInputs: { metricName: model.metricName },
				toParentMessage: (message) => Message.GotAddToDashboardMessage({ message }),
			}),
			queryControls(h, model, summary.metricType, summary.isMonotonic),
			h.div(
				[h.Class("grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]")],
				[
					h.div(
						[h.Class("flex min-w-0 flex-col gap-4")],
						[
							metricChart(h, model, draft, summary.unit, timeZone),
							metricBreakdown(h, model, draft),
						],
					),
					metadataPanel(h, model, summary, timeZone),
				],
			),
		],
	)
}

const body = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.catalog.data, {
		onEmpty: () => loading(h),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load metric", onRetry: Message.ClickedReload() }),
		onData: () => {
			const summary = summaryOf(model)
			return summary === null ? noData(h, model.metricName) : content(h, model, summary, timeZone)
		},
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: AREA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					// A metric name is an identifier, so it is set in mono like elsewhere.
					titleContent: pageTitle(
						h,
						{ title: model.metricName, className: "font-mono text-xl leading-8 tracking-normal" },
						[model.metricName],
					),
					actions: actions(h, model),
				},
				[body(h, model, inputs.context.timeZone)],
			),
		],
	),
)
