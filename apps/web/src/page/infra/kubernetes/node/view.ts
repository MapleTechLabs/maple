import {
	capacityFraction,
	formatBytesOfAllocatable,
	formatCoresOfAllocatable,
	severityLevel,
} from "../../../../components/infra/format"
import { EMPTY_VALUE, formatPercent, formatUptime } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { segmentedSelect } from "../../../../ui/segmented-select"
import { skeletonList } from "../../../../ui/skeleton"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import * as Frame from "../../kit/frame"
import { heroChip } from "../../kit/hero-chip"
import { k8sChart } from "../../kit/k8s-chart"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { noMetricsMessage, pageHeroParts } from "../../kit/page-parts"
import {
	metaRow,
	resourceAttributesCard,
	resourceAttributesCardSkeleton,
} from "../../kit/resource-attributes"
import { sectionHeading } from "../../../kit/section-heading"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import { kubernetesViewTabs, pickTimeSearch } from "../../kit/view-tabs"
import { podTable } from "../pod-table"
import { Message } from "./message"
import type { Model, NodeMetric, NodeSummary } from "./model"
import { DEFAULT_PRESET } from "./update"

// `NodeDetailPage` in `KubernetesShell`.

type H = HtmlBuilder<Message>
type Summary = NonNullable<NodeSummary>

const METRIC_OPTIONS: ReadonlyArray<Readonly<{ value: NodeMetric; label: string }>> = [
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "cpu_utilization", label: "CPU / allocatable" },
	{ value: "memory_usage", label: "Memory" },
	{ value: "memory_utilization", label: "Memory / allocatable" },
	{ value: "uptime", label: "Uptime" },
]

const METRIC_LABELS = new Map<NodeMetric, string>([
	["cpu_usage", "CPU usage"],
	["cpu_utilization", "CPU / allocatable"],
	["memory_usage", "Memory working set"],
	["memory_utilization", "Memory / allocatable"],
	["uptime", "Uptime"],
])

const rightPanel = (h: H, model: Model): Html | undefined => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	if (summary !== null)
		return resourceAttributesCard(h, "ServerIcon", [
			metaRow(h, { label: "k8s.node.name", value: summary.nodeName }),
			metaRow(h, { label: "k8s.node.uid", value: summary.nodeUid }),
			metaRow(h, { label: "k8s.kubelet.version", value: summary.kubeletVersion }),
			metaRow(h, { label: "container.runtime", value: summary.containerRuntime }),
		])
	return AsyncData.isLoading(model.summary.data) || AsyncData.isIdle(model.summary.data)
		? resourceAttributesCardSkeleton(h, "ServerIcon")
		: undefined
}

/** `CapacityStat`. */
const capacityStat = (h: H, eyebrow: string, fraction: number, subline: string): Html =>
	statRailItem(h, {
		eyebrow,
		value: formatPercent(fraction),
		tone: severityLevel(fraction),
		subline,
		compact: true,
	})

const stats = (h: H, summary: Summary): Html =>
	statRail(h, { columns: 4 }, [
		capacityStat(
			h,
			"CPU / allocatable",
			capacityFraction(summary.cpuUtilization, summary.cpuAllocatable),
			formatCoresOfAllocatable(summary.cpuUsage, summary.cpuAllocatable),
		),
		capacityStat(
			h,
			"Memory / allocatable",
			capacityFraction(summary.memoryUtilization, summary.memoryAllocatable),
			formatBytesOfAllocatable(summary.memoryUsage, summary.memoryAllocatable),
		),
		statRailItem(h, { eyebrow: "Uptime", value: formatUptime(summary.uptime), compact: true }),
		statRailItem(h, { eyebrow: "Kubelet", value: summary.kubeletVersion || EMPTY_VALUE, compact: true }),
	])

const podsOnNode = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.pods.data, {
		onEmpty: () => skeletonList(h, { rows: 4, rowClassName: "h-9", label: "Loading pods" }),
		onFailure: (failure) => errorState(h, { failure, title: "Couldn't load pods on this node" }),
		onData: (page) =>
			page.data.length === 0
				? emptyMessage(h, { dashed: true, className: "py-12" }, [
						"No pods reporting on this node in the selected window.",
					])
				: podTable(h, page.data, {
						sortBy: "saturation",
						sortDir: "desc",
						timeSearch: pickTimeSearch(model.search),
						isWaiting: false,
						referenceTime: model.frame.window?.endTime ?? "",
						nowMs: model.frame.nowMs,
						timeZone: inputs.context.timeZone,
						restarts: Option.none(),
					}),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	const metric = model.metric
	const hero = pageHeroParts(h, {
		title: h.span([h.Class("font-mono")], [model.nodeName]),
		description: "Usage from the kubelet stats receiver, allocatable capacity from the cluster receiver.",
		meta:
			summary === null
				? undefined
				: [
						...(summary.kubeletVersion
							? [heroChip(h, ["kubelet ", summary.kubeletVersion])]
							: []),
						...(summary.containerRuntime
							? [heroChip(h, ["runtime ", summary.containerRuntime])]
							: []),
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
					tabs: kubernetesViewTabs(h, "nodes", model.search),
					rightPanel: rightPanel(h, model),
				},
				[
					h.div(
						[h.Class("space-y-6")],
						[
							hero.body,
							summary === null ? noMetricsMessage(h, "node") : stats(h, summary),
							h.div(
								[h.Class("space-y-3")],
								[
									segmentedSelect(h, {
										size: "xs",
										options: METRIC_OPTIONS,
										value: metric,
										onChange: (value) => Message.ClickedMetric({ metric: value }),
										ariaLabel: "Metric",
									}),
									k8sChart(h, {
										slot: model.series[metric],
										chart: model.charts[metric],
										toChart: (message) => Message.GotChartMessage({ metric, message }),
										chartId: `node-${metric}`,
										seriesLabel: METRIC_LABELS.get(metric) ?? metric,
										theme: model.themeColors,
										runtime: model.chartRuntime,
										timeZone: inputs.context.timeZone,
									}),
								],
							),
							h.div(
								[h.Class("space-y-3")],
								[
									sectionHeading(h, { as: "h3", title: "Pods on this node" }),
									podsOnNode(h, model, inputs),
								],
							),
						],
					),
				],
			),
		],
	)
})
