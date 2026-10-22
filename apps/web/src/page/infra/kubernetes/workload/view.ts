import { severityLevel } from "../../../../components/infra/format"
import { countLabel, EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { segmentedSelect } from "../../../../ui/segmented-select"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import * as Frame from "../../kit/frame"
import { heroChip } from "../../kit/hero-chip"
import { k8sChart } from "../../kit/k8s-chart"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { noMetricsMessage, pageHero } from "../../kit/page-parts"
import {
	metaRow,
	resourceAttributesCard,
	resourceAttributesCardSkeleton,
} from "../../kit/resource-attributes"
import { sectionHeading } from "../../../kit/section-heading"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { kubernetesViewTabs, pickTimeSearch } from "../../kit/view-tabs"
import { podTable, podTableLoading } from "../pod-table"
import { Message } from "./message"
import { type Model, seriesId, type WorkloadKind, type WorkloadMetric, type WorkloadSummary } from "./model"
import { DEFAULT_PRESET } from "./update"

// `WorkloadDetailPage` and `WorkloadDetailChart`.

type H = HtmlBuilder<Message>
type Summary = NonNullable<WorkloadSummary>

const METRIC_OPTIONS: ReadonlyArray<Readonly<{ value: WorkloadMetric; label: string }>> = [
	{ value: "cpu_limit", label: "CPU / limit" },
	{ value: "memory_limit", label: "Mem / limit" },
	{ value: "cpu_usage", label: "CPU cores" },
]

const METRIC_LABELS = new Map<WorkloadMetric, string>([
	["cpu_usage", "CPU usage"],
	["cpu_limit", "CPU / limit"],
	["memory_limit", "Memory / limit"],
])

export const KIND_LABEL = new Map<WorkloadKind, string>([
	["deployment", "Deployment"],
	["statefulset", "StatefulSet"],
	["daemonset", "DaemonSet"],
	["job", "Job"],
])

const rightPanel = (h: H, model: Model): Html | undefined => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	if (summary !== null)
		return resourceAttributesCard(h, "GridIcon", [
			metaRow(h, { label: "kind", value: KIND_LABEL.get(model.kind) }),
			metaRow(h, { label: `k8s.${model.kind}.name`, value: summary.workloadName }),
			metaRow(h, { label: "k8s.namespace.name", value: summary.namespace }),
			metaRow(h, { label: "pods", value: String(summary.podCount) }),
		])
	return AsyncData.isLoading(model.summary.data) || AsyncData.isIdle(model.summary.data)
		? resourceAttributesCardSkeleton(h, "GridIcon")
		: undefined
}

const stats = (h: H, summary: Summary): Html =>
	statRail(h, {}, [
		statRailItem(h, { eyebrow: "Pods", value: String(summary.podCount), compact: true }),
		statRailItem(h, {
			eyebrow: "Avg CPU vs limit",
			value: formatPercent(summary.avgCpuLimitPct),
			tone: severityLevel(summary.avgCpuLimitPct),
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Avg memory vs limit",
			value: formatPercent(summary.avgMemoryLimitPct),
			tone: severityLevel(summary.avgMemoryLimitPct),
			compact: true,
		}),
		statRailItem(h, {
			eyebrow: "Avg CPU cores",
			value: Number.isFinite(summary.avgCpuUsage) ? summary.avgCpuUsage.toFixed(3) : EMPTY_VALUE,
			compact: true,
		}),
	])

const summaryArea = (h: H, model: Model): Html =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => statRailLoading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load workload metrics",
				onRetry: Message.ClickedRetrySummary(),
			}),
		onData: (summary) => (summary === null ? noMetricsMessage(h, "workload") : stats(h, summary)),
	})

const podsArea = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.pods.data, {
		onEmpty: () => podTableLoading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load workload pods",
				onRetry: Message.ClickedRetryPods(),
			}),
		onData: (page) =>
			page.data.length === 0
				? emptyMessage(h, { dashed: true, className: "py-12" }, [
						"No pods reporting for this workload in the selected window.",
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

const chartArea = (h: H, model: Model, inputs: PageViewInputs): Html => {
	const metric = model.metric
	return h.div(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-3")],
				[
					segmentedSelect(h, {
						size: "xs",
						options: METRIC_OPTIONS,
						value: metric,
						onChange: (value) => Message.ClickedMetric({ metric: value }),
						ariaLabel: "Metric",
					}),
					h.label(
						[h.Class("inline-flex items-center gap-2 text-2xs text-muted-foreground")],
						[
							h.input([
								h.Type("checkbox"),
								h.Checked(model.groupByPod),
								h.Class("size-3 accent-primary"),
								h.OnClick(Message.ToggledGroupByPod({ isChecked: !model.groupByPod })),
							]),
							"Per-pod breakdown",
						],
					),
				],
			),
			k8sChart(h, {
				slot: model.series[seriesId(model)],
				chart: model.charts[metric],
				toChart: (message) => Message.GotChartMessage({ metric, message }),
				chartId: `workload-${metric}`,
				seriesLabel: METRIC_LABELS.get(metric) ?? metric,
				showThreshold: metric === "cpu_limit" || metric === "memory_limit",
				theme: model.themeColors,
				runtime: model.chartRuntime,
				timeZone: inputs.context.timeZone,
			}),
		],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const summary = AsyncData.getOrElse(model.summary.data, () => null)
	const namespace = model.search.namespace
	const kindLabel = KIND_LABEL.get(model.kind) ?? model.kind
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					actions: Frame.controls(
						h,
						model.frame,
						{ search: model.search, defaultPreset: DEFAULT_PRESET },
						toFrame,
					),
					tabs: kubernetesViewTabs(h, "workloads", model.search),
					rightPanel: rightPanel(h, model),
				},
				[
					h.div(
						[h.Class("space-y-6")],
						[
							pageHero(h, {
								title: h.span([h.Class("font-mono")], [model.workloadName]),
								description: `${kindLabel}${namespace ? ` in namespace ${namespace}` : ""}, aggregated from pod metrics.`,
								meta: [
									...(namespace ? [heroChip(h, ["ns ", namespace])] : []),
									heroChip(h, ["kind ", model.kind]),
									...(summary === null
										? []
										: [heroChip(h, [countLabel(summary.podCount, "pod")])]),
								],
							}),
							summaryArea(h, model),
							chartArea(h, model, inputs),
							h.div(
								[h.Class("space-y-3")],
								[sectionHeading(h, { as: "h3", title: "Pods" }), podsArea(h, model, inputs)],
							),
						],
					),
				],
			),
		],
	)
})
