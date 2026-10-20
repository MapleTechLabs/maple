import { severityLevel } from "../../../../components/infra/format"
import { podKey } from "../../../../components/infra/pod-restarts"
import { formatPercent } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "../../../../ui/button"
import * as DialogView from "../../../../ui/dialog-view"
import { kbd } from "../../../../ui/display"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { skeleton } from "../../../../ui/skeleton"
import { k8sChart } from "../../kit/k8s-chart"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import type { TimeSearch } from "../../kit/view-tabs"
import { POD_METRIC_LABELS, type PodRow } from "../pod-data"
import { MountPeekKeys } from "./keys"
import { Message } from "./message"
import { type Model, PEEK_CHART_HEIGHT, PEEK_METRICS, seriesId } from "./model"
import type { Peek } from "./update"
import { peekHeader } from "./view-header"

// `PodPeekSheet`.

type H = HtmlBuilder<Message>

export type ViewInputs = Readonly<{
	peek: Peek | null
	referenceTime: string
	nowMs: number
	timeZone: string
	timeSearch: TimeSearch
	/** The browser's locale for the "1 of N" counter. */
	locale: string
}>

const compactItem = (h: H, eyebrow: string, value: number, isToned: boolean): Html =>
	statRailItem(h, {
		eyebrow,
		value: formatPercent(value),
		tone: isToned ? severityLevel(value) : undefined,
		compact: true,
		className: "px-4 py-3",
		valueClassName: "text-xl",
	})

/** `PeekSummary`: the four limit ratios the pod page leads with, over the list's window. */
const peekSummary = (h: H, model: Model, pod: PodRow): Html => {
	const data = model.summaries[podKey(pod)]?.data ?? AsyncData.Idle()
	return AsyncData.matchData(data, {
		onEmpty: () => skeleton(h, "h-[88px] w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Failed to load pod metrics", onRetry: Message.ClickedRetrySummary() }),
		onData: (summary) =>
			summary === null || summary === undefined
				? emptyMessage(h, { dashed: true }, ["No metrics arrived for this pod in this window."])
				: statRail(h, { className: refreshingClass(AsyncData.isRefreshing(data)) }, [
						compactItem(h, "CPU vs limit", summary.cpuLimitPct, true),
						compactItem(h, "CPU vs request", summary.cpuRequestPct, false),
						compactItem(h, "Mem vs limit", summary.memoryLimitPct, true),
						compactItem(h, "Mem vs request", summary.memoryRequestPct, false),
					]),
	})
}

const peekCharts = (h: H, model: Model, pod: PodRow, timeZone: string): Html =>
	h.div(
		[h.Class("space-y-3")],
		PEEK_METRICS.map((metric) =>
			k8sChart(h, {
				slot: model.series[seriesId(podKey(pod), metric)],
				chart: model.charts[metric],
				toChart: (message) => Message.GotChartMessage({ id: metric, message }),
				chartId: `pod-${metric}`,
				seriesLabel: POD_METRIC_LABELS.get(metric) ?? metric,
				showThreshold: metric.startsWith("cpu_") || metric.startsWith("memory_"),
				height: PEEK_CHART_HEIGHT,
				theme: model.themeColors,
				runtime: model.chartRuntime,
				timeZone,
			}),
		),
	)

const stepButton = (h: H, label: string, iconName: "ArrowUpIcon" | "ArrowDownIcon", isEnabled: boolean, step: 1 | -1) =>
	iconButton(
		h,
		{
			variant: "outline",
			label,
			isDisabled: !isEnabled,
			attributes: [h.OnClick(Message.ClickedStep({ step }))],
		},
		[icon(h, iconName)],
	)

const peekFooter = (h: H, peek: Peek, timeSearch: TimeSearch, locale: string): Html =>
	DialogView.dialogFooter(
		h,
		"sheet",
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					stepButton(h, "Previous pod", "ArrowUpIcon", peek.index > 0, -1),
					stepButton(h, "Next pod", "ArrowDownIcon", peek.index < peek.count - 1, 1),
					h.span(
						[h.Class("ml-1 font-mono text-2xs tabular-nums text-muted-foreground")],
						[(peek.index + 1).toLocaleString(locale), " of", " ", peek.count.toLocaleString(locale)],
					),
					h.span(
						[h.Class("ml-2 hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex")],
						[kbd(h, undefined, ["↑"]), kbd(h, undefined, ["↓"]), " walk the list"],
					),
				],
			),
			linkButton(
				h,
				{
					size: "sm",
					href: hrefOf(
						AppRoute.InfraKubernetesPod({
							podName: peek.pod.podName,
							search: { ...timeSearch, namespace: peek.pod.namespace || undefined },
						}),
					),
				},
				["Open pod", icon(h, "ArrowRightIcon")],
			),
		],
		"flex-row items-center justify-between gap-3 border-t",
	)

const content = (h: H, model: Model, peek: Peek, inputs: ViewInputs): ReadonlyArray<Html> => [
	h.span([h.Hidden(true), h.OnMount(MountPeekKeys())], []),
	peekHeader(h, peek.pod, {
		dialogId: model.dialog.id,
		referenceTime: inputs.referenceTime,
		nowMs: inputs.nowMs,
		timeZone: inputs.timeZone,
	}),
	DialogView.dialogPanel(
		h,
		"sheet",
		model.dialog.id,
		[peekSummary(h, model, peek.pod), peekCharts(h, model, peek.pod, inputs.timeZone)],
		"space-y-5",
	),
	peekFooter(h, peek, inputs.timeSearch, inputs.locale),
]

/** The sheet; its content renders only while a row is peeked. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			h.submodel({
				slotId: `${model.dialog.id}-sheet`,
				model: model.dialog,
				view: DialogView.view,
				viewInputs: {
					className: "p-0 sm:max-w-xl",
					side: "right",
					hasTrigger: false,
					toView: ({ portal }) => portal,
					toContent: () => (inputs.peek === null ? [] : content(h, model, inputs.peek, inputs)),
				},
				toParentMessage: (message) => Message.GotDialogMessage({ message }),
			}),
		],
	),
)
