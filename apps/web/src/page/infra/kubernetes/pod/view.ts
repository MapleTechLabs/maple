import { severityLevel } from "../../../../components/infra/format"
import { formatPercent } from "@maple/ui/lib/format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { errorState } from "../../../../ui/error-state"
import { segmentedSelect } from "../../../../ui/segmented-select"
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
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { kubernetesViewTabs } from "../../kit/view-tabs"
import { POD_METRIC_LABELS, type PodMetric, type PodSummary } from "../pod-data"
import { podContainerRestarts, podRestartsStat } from "../pod-restarts-view"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"

// `PodDetailPage` in `KubernetesShell`.

type H = HtmlBuilder<Message>
type Summary = NonNullable<PodSummary>

const METRIC_OPTIONS: ReadonlyArray<Readonly<{ value: PodMetric; label: string }>> = [
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "cpu_limit", label: "CPU / limit" },
	{ value: "cpu_request", label: "CPU / request" },
	{ value: "memory_limit", label: "Mem / limit" },
	{ value: "memory_request", label: "Mem / request" },
]

const rail = (h: H, summary: Summary): Html =>
	resourceAttributesCard(h, "FolderIcon", [
		metaRow(h, { label: "k8s.pod.name", value: summary.podName }),
		metaRow(h, { label: "k8s.namespace.name", value: summary.namespace }),
		metaRow(h, { label: "k8s.node.name", value: summary.nodeName }),
		metaRow(h, { label: "k8s.pod.uid", value: summary.podUid }),
		metaRow(h, { label: "k8s.pod.qos_class", value: summary.qosClass }),
		metaRow(h, { label: "k8s.deployment.name", value: summary.deploymentName }),
		metaRow(h, { label: "k8s.statefulset.name", value: summary.statefulsetName }),
		metaRow(h, { label: "k8s.daemonset.name", value: summary.daemonsetName }),
		metaRow(h, { label: "k8s.pod.start_time", value: summary.podStartTime }),
	])

const rightPanel = (h: H, model: Model): Html | undefined => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	if (summary !== null) return rail(h, summary)
	return AsyncData.isLoading(model.summary.data) || AsyncData.isIdle(model.summary.data)
		? resourceAttributesCardSkeleton(h, "FolderIcon")
		: undefined
}

const stats = (h: H, model: Model, summary: Summary): Html =>
	statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "CPU vs limit",
			value: formatPercent(summary.cpuLimitPct),
			tone: severityLevel(summary.cpuLimitPct),
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "CPU vs request",
			value: formatPercent(summary.cpuRequestPct),
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Memory vs limit",
			value: formatPercent(summary.memoryLimitPct),
			tone: severityLevel(summary.memoryLimitPct),
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Memory vs request",
			value: formatPercent(summary.memoryRequestPct),
			compact: true,
		}),
		podRestartsStat(h, model.restarts.data),
	])

const summaryArea = (h: H, model: Model): Html =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => statRailLoading(h, 5, 5),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load pod metrics",
				onRetry: Message.ClickedRetrySummary(),
			}),
		onData: (summary) => (summary === null ? noMetricsMessage(h, "pod") : stats(h, model, summary)),
	})

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	const metric = model.metric
	const namespace = model.search.namespace
	const hero = pageHeroParts(h, {
		title: h.span([h.Class("font-mono")], [model.podName]),
		description: "Pod metrics from the kubelet stats receiver; restarts from the cluster receiver.",
		meta: [
			...(namespace ? [heroChip(h, ["ns ", namespace])] : []),
			...(summary?.nodeName ? [heroChip(h, ["node ", summary.nodeName])] : []),
			...(summary?.qosClass ? [heroChip(h, ["qos ", summary.qosClass])] : []),
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
					tabs: kubernetesViewTabs(h, "pods", model.search),
					rightPanel: rightPanel(h, model),
				},
				[
					h.div(
						[h.Class("space-y-6")],
						[
							hero.body,
							summaryArea(h, model),
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
										chartId: `pod-${metric}`,
										seriesLabel: POD_METRIC_LABELS.get(metric) ?? metric,
										showThreshold:
											metric.startsWith("cpu_") || metric.startsWith("memory_"),
										theme: model.themeColors,
										runtime: model.chartRuntime,
										timeZone: inputs.context.timeZone,
									}),
								],
							),
							podContainerRestarts(h, model.restarts.data),
						],
					),
				],
			),
		],
	)
})
