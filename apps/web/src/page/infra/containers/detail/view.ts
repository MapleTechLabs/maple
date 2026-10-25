import { formatSeconds } from "../../../../components/infra/chart-units"
import { severityLevel } from "../../../../components/infra/format"
import { formatBytes, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { button, linkButton } from "../../../../ui/button"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { segmentedSelect } from "../../../../ui/segmented-select"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { heroChip } from "../../kit/hero-chip"
import * as Frame from "../../kit/frame"
import { k8sChart } from "../../kit/k8s-chart"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { pageHeroParts } from "../../kit/page-parts"
import {
	metaRow,
	resourceAttributesCard,
	resourceAttributesCardSkeleton,
} from "../../kit/resource-attributes"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { Message } from "./message"
import type { ContainerMetric, ContainerSummary, Model } from "./model"
import { DEFAULT_PRESET } from "./update"

// `ContainerDetailPage` and `ContainerDetailChart`.

type H = HtmlBuilder<Message>
type Summary = NonNullable<ContainerSummary>

const METRIC_TABS: ReadonlyArray<Readonly<{ value: ContainerMetric; label: string }>> = [
	{ value: "cpu", label: "CPU %" },
	{ value: "memory_percent", label: "Mem / limit" },
	{ value: "memory_bytes", label: "Memory" },
	{ value: "network", label: "Network I/O" },
	{ value: "disk_io", label: "Block I/O" },
]

const METRIC_LABELS = new Map<ContainerMetric, string>([
	["cpu", "CPU"],
	["memory_percent", "Memory / limit"],
	["memory_bytes", "Memory usage"],
	["network", "Network I/O"],
	["disk_io", "Block I/O"],
])

const rail = (h: H, summary: Summary): Html =>
	resourceAttributesCard(h, "DockerIcon", [
		metaRow(h, { label: "container.name", value: summary.containerName }),
		metaRow(h, { label: "container.id", value: summary.containerId }),
		metaRow(h, { label: "container.image.name", value: summary.imageName }),
		metaRow(h, { label: "container.runtime", value: summary.runtime }),
		metaRow(h, { label: "host.name", value: summary.hostName }),
		metaRow(h, { label: "compose.project", value: summary.composeProject }),
		metaRow(h, { label: "compose.service", value: summary.composeService }),
	])

const rightPanel = (h: H, model: Model): Html | undefined => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	if (summary !== null) return rail(h, summary)
	return AsyncData.isLoading(model.summary.data) || AsyncData.isIdle(model.summary.data)
		? resourceAttributesCardSkeleton(h, "DockerIcon")
		: undefined
}

const stats = (h: H, summary: Summary): Html =>
	statRail(h, {}, [
		statRailItem(h, {
			eyebrow: "CPU",
			value: formatPercent(summary.cpuPct),
			tone: severityLevel(summary.cpuPct),
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Memory vs limit",
			value: formatPercent(summary.memoryPct),
			tone: severityLevel(summary.memoryPct),
			compact: true,
		}),
		statRailItem(h, { eyebrow: "Memory", value: formatBytes(summary.memoryBytesAvg), compact: true }),
		statRailItem(h, {
			eyebrow: "Restarts",
			value: formatNumber(summary.restartsDelta),
			tone: summary.restartsDelta > 0 ? "warn" : undefined,
			compact: true,
		}),
		statRailItem(h, { eyebrow: "Uptime", value: formatSeconds(summary.uptimeSeconds), compact: true }),
	])

const noData = (h: H, model: Model): Html =>
	emptyMessage(h, { dashed: true, className: "flex flex-col items-center gap-3 py-12" }, [
		h.p(
			[],
			[
				"This container sent no metrics in the selected window. It may have stopped earlier: try a wider range, or go back to the containers list.",
			],
		),
		h.div(
			[h.Class("flex flex-wrap items-center justify-center gap-2")],
			[
				...(Frame.canWidenTimeRange(model.search, DEFAULT_PRESET)
					? [
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [h.OnClick(Message.ClickedWidenRange())],
								},
								["Show last 7 days"],
							),
						]
					: []),
				linkButton(
					h,
					{
						variant: "outline",
						size: "sm",
						href: hrefOf(AppRoute.InfraContainers({ search: {} })),
					},
					["Back to containers"],
				),
			],
		),
	])

const summaryArea = (h: H, model: Model): Html =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => statRailLoading(h, 5),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load container metrics",
				onRetry: Message.ClickedRetrySummary(),
			}),
		onData: (summary) => (summary === null ? noData(h, model) : stats(h, summary)),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	const metric = model.metric
	const hero = pageHeroParts(h, {
		title: h.span([h.Class("font-mono")], [model.containerName]),
		description: "Container metrics from the Docker stats receiver.",
		meta: [
			...(summary?.hostName ? [heroChip(h, ["host ", summary.hostName])] : []),
			...(summary?.imageName ? [heroChip(h, ["image ", summary.imageName])] : []),
			...(summary?.runtime ? [heroChip(h, ["runtime ", summary.runtime])] : []),
		],
	})
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					titleContent: hero.title,
					actions: Frame.controls(
						h,
						model.frame,
						{ search: model.search, defaultPreset: DEFAULT_PRESET },
						toFrame,
					),
					rightPanel: rightPanel(h, model),
					scrollClassName: "gap-6",
				},
				[
					hero.body,
					summaryArea(h, model),
					h.div(
						[h.Class("space-y-3")],
						[
							segmentedSelect(h, {
								size: "xs",
								options: METRIC_TABS,
								value: metric,
								onChange: (value) => Message.ClickedMetric({ metric: value }),
								ariaLabel: "Metric",
							}),
							k8sChart(h, {
								slot: model.series[metric],
								chart: model.charts[metric],
								toChart: (message) => Message.GotChartMessage({ metric, message }),
								chartId: `container-${metric}`,
								seriesLabel: METRIC_LABELS.get(metric) ?? metric,
								showThreshold: metric === "cpu" || metric === "memory_percent",
								theme: model.themeColors,
								runtime: model.chartRuntime,
								timeZone: inputs.context.timeZone,
							}),
						],
					),
				],
			),
		],
	)
})
