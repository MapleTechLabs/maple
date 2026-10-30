import { deriveLensVerdict, lensHeadline, lensSubhead } from "../../../../components/infra/service-lens/service-lens-summary"
import { unifiedBucketDomain } from "../../../../components/infra/service-lens/bucket-domain"
import { countLabel, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyMessage, emptyTitle } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { skeleton } from "../../../../ui/skeleton"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import * as Frame from "../../kit/frame"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { chartLoading } from "../../../../ui/chart-state"
import { pageHero } from "../../kit/page-parts"
import { docsLink } from "../../../kit/signal-empty-state"
import { sectionHeading } from "../../../kit/section-heading"
import { kubernetesViewTabs } from "../../kit/view-tabs"
import { lensRail, railState } from "../lens/rail-view"
import type { PodRow } from "../pod-data"
import { podTable, podTableLoading } from "../pod-table"
import { bucketSecondsOf, cpuRowsOf, type LinkedWorkload, linkedWorkload, worstPerBucket } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import * as Chart from "../../../../charts/chart"
import * as InfraMetricChart from "../../../../charts/infra-metric-chart"
import { MountLinkedCursor } from "../../../../charts/linked-cursor"
import { correlationStrips, type StripSeries } from "../../kit/correlation-strips"

// `ServiceLensPage` / `LensBody` in `ServiceLensShell`.

type H = HtmlBuilder<Message>

const isInitial = (data: AsyncData.AsyncData<unknown, unknown>) => AsyncData.isIdle(data) || AsyncData.isLoading(data)

const workloadMeta = (h: H, model: Model, serviceName: string, workload: LinkedWorkload | null): Html => {
	if (workload === null) return null
	return h.div(
		[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 font-mono text-2xs text-muted-foreground")],
		[
			h.a(
				[
					h.Href(
						hrefOf(
							AppRoute.InfraKubernetesWorkload({
								kind: workload.workloadKind,
								workloadName: workload.workloadName,
								search: { namespace: workload.namespace || undefined },
							}),
						),
					),
					h.Class("hover:text-foreground"),
				],
				[workload.workloadKind, " ", workload.workloadName],
			),
			...(workload.namespace ? [h.span([], ["ns ", workload.namespace])] : []),
			...(workload.clusterName ? [h.span([], ["cluster ", workload.clusterName])] : []),
			h.a(
				[
					h.Href(hrefOf(AppRoute.Service({ serviceName, search: model.search }))),
					h.Class("text-primary hover:underline"),
				],
				["Open the service"],
			),
		],
	)
}

const noWorkload = (h: H, serviceName: string): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GridIcon", { size: 16 })]),
				emptyTitle(h, ["No Kubernetes workload for ", serviceName]),
				emptyDescription(h, [
					"Maple links a service to its pods through the k8s.deployment.name (or statefulset / daemonset) attribute on its spans. Enable the k8sattributes processor in the Helm chart so the collector tags them.",
				]),
			]),
			docsLink(h, "kubernetes"),
		],
		"py-16",
	)

const podsSection = (h: H, model: Model, inputs: PageViewInputs, pods: ReadonlyArray<PodRow>, totalPods: number): Html =>
	h.section(
		[h.Class("space-y-2.5")],
		[
			sectionHeading(h, {
				title: "The pods behind this service",
				hint: "worst first, by peak saturation",
				actions: h.span([h.Class("font-mono text-2xs tabular-nums text-muted-foreground")], [
					totalPods > pods.length ? `Top ${pods.length} of ${formatNumber(totalPods)}` : countLabel(totalPods, "pod"),
				]),
			}),
			AsyncData.matchData(model.pods.data, {
				onEmpty: () => podTableLoading(h),
				onFailure: (failure) => errorState(h, { failure, title: "Couldn't load pods", onRetry: Message.ClickedRetryPods() }),
				onData: (page) =>
					page.data.length === 0
						? emptyMessage(h, { dashed: true, className: "py-12" }, [
								"No pods reported for this workload in the selected window.",
							])
						: podTable(h, page.data, {
								sortBy: "saturation",
								sortDir: "desc",
								timeSearch: {},
								isWaiting: AsyncData.isRefreshing(model.pods.data),
								referenceTime: model.frame.window?.endTime ?? "",
								nowMs: model.frame.nowMs,
								timeZone: inputs.context.timeZone,
								restarts: Option.none(),
							}),
			}),
		],
	)

const lensBody = (h: H, model: Model, serviceName: string, inputs: PageViewInputs): Html => {
	if (AsyncData.isFailure(model.overview.data))
		return AsyncData.matchData(model.overview.data, {
			onEmpty: () => null,
			onData: () => null,
			onFailure: (failure) =>
				errorState(h, { failure, title: "Couldn't load this service", onRetry: Message.ClickedRetryOverview() }),
		})
	const workload = linkedWorkload(model)
	const points = AsyncData.getOrElse(model.overview.data, () => [])
	const cpuRows = cpuRowsOf(model)
	const pods = AsyncData.getOrElse(model.pods.data, () => null)?.data ?? []
	const totalPods = AsyncData.getOrElse(model.pods.data, () => null)?.totalCount ?? 0
	const worstCpuRows = worstPerBucket(cpuRows)
	const window = model.frame.window
	const verdict = deriveLensVerdict({
		hasWorkload: workload !== null,
		pods,
		totalPods,
		latency: points.map((point) => ({ bucket: point.bucket, value: point.p99LatencyMs, hasTraffic: point.totalCount > 0 })),
		cpuOfLimit: worstCpuRows,
		bucketSeconds: window === null ? 0 : bucketSecondsOf(model, window),
	})
	const evidenceMissing =
		workload !== null && (AsyncData.isFailure(model.pods.data) || AsyncData.isFailure(model.cpu.data))
	const isLoading =
		isInitial(model.overview.data) ||
		isInitial(model.linked.data) ||
		(workload !== null && (isInitial(model.pods.data) || isInitial(model.cpu.data)))
	const isWaiting = AsyncData.isRefreshing(model.overview.data) || AsyncData.isRefreshing(model.cpu.data)
	const strips: ReadonlyArray<StripSeries> = [
		{
			id: "p99",
			label: "p99 latency",
			source: "from spans",
			unit: "milliseconds",
			rows: points.map((p) => ({ bucket: p.bucket, attributeValue: "", value: p.p99LatencyMs })),
		},
		{
			id: "cpu",
			label: "CPU of limit",
			source: workload === null ? "no workload" : `worst pod · ${workload.workloadName}`,
			unit: "percent",
			showThreshold: true,
			rows: worstCpuRows.map((row) => ({ ...row, attributeValue: "" })),
		},
		{
			id: "throughput",
			label: "Throughput",
			source: "spans per second",
			unit: "rate",
			rows: points.map((p) => ({ bucket: p.bucket, attributeValue: "", value: p.throughput })),
		},
	]
	const xDomain = unifiedBucketDomain([points.map((p) => p.bucket), cpuRows.map((r) => r.bucket)])
	const theme = model.themeColors
	return h.div(
		[h.Class("space-y-7 pb-4")],
		[
			isLoading
				? h.header(
						[h.Class("space-y-3")],
						[skeleton(h, "h-9 w-[520px]"), skeleton(h, "h-4 w-[420px]"), workloadMeta(h, model, serviceName, workload)],
					)
				: pageHero(h, {
						title: evidenceMissing ? `${serviceName}: evidence incomplete.` : lensHeadline(verdict, serviceName),
						description: evidenceMissing
							? "The pod list or the CPU series failed to load, so this page can't say whether Kubernetes is involved. The charts below show what did arrive."
							: lensSubhead(verdict),
						meta: workload === null ? undefined : [workloadMeta(h, model, serviceName, workload)],
					}),
			...(workload === null && !isLoading
				? [noWorkload(h, serviceName)]
				: [
						h.section(
							[h.Class("space-y-2.5")],
							[
								sectionHeading(h, {
									title: "Service signal over infrastructure signal",
									hint: "one cursor, one time axis",
								}),
								isLoading || theme === null || model.chartRuntime._tag === "Loading"
									? chartLoading(h, { variant: "line", height: 360 })
									: correlationStrips(h, {
											strips,
											xDomain,
											isWaiting,
											theme,
											timeZone: inputs.context.timeZone,
											mountCursor: h.OnMount(MountLinkedCursor()),
											chart: (chartId, chartInputs) =>
												h.submodel({
													slotId: chartId,
													model: model.charts[chartId] ?? Chart.init(),
													view: InfraMetricChart.view,
													toParentMessage: (message: Chart.Message) =>
														Message.GotChartMessage({ id: chartId, message }),
													viewInputs: { ...chartInputs, chartId },
												}),
										}),
							],
						),
						podsSection(h, model, inputs, pods, totalPods),
						...(workload === null ? [] : [podDistribution(h, pods, isWaiting)]),
					]),
		],
	)
}

/** `PodDistribution`: which nodes the service landed on; nothing for one node. */
const podDistribution = (h: H, pods: ReadonlyArray<PodRow>, isWaiting: boolean): Html => {
	const byNode = [
		...pods
			.reduce((map, pod) => {
				const node = pod.nodeName || "unknown"
				const existing = map.get(node) ?? { count: 0, worst: 0 }
				return map.set(node, { count: existing.count + 1, worst: Math.max(existing.worst, pod.saturation) })
			}, new Map<string, { count: number; worst: number }>())
			.entries(),
	].sort((a, b) => b[1].worst - a[1].worst)
	if (byNode.length <= 1) return null
	return h.section(
		[h.Class(cn("space-y-2.5", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			sectionHeading(h, { title: "Spread across nodes" }),
			h.div(
				[h.Class("flex flex-wrap gap-2")],
				byNode.map(([node, { count, worst }]) =>
					h.a(
						[
							h.Key(node),
							h.Href(hrefOf(AppRoute.InfraKubernetesNode({ nodeName: node, search: {} }))),
							h.Class(
								"flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 font-mono text-2xs transition-colors hover:bg-surface-sunken",
							),
						],
						[
							h.span([h.Class("text-foreground")], [node]),
							h.span([h.Class("text-muted-foreground")], [countLabel(count, "pod")]),
							h.span([h.Class("tabular-nums text-muted-foreground")], ["worst ", formatPercent(worst)]),
						],
					),
				),
			),
		],
	)
}

const lensEmpty = (h: H, title: string, description: string, hasDocs: boolean): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "KubernetesIcon", { size: 16 })]),
				emptyTitle(h, [title]),
				emptyDescription(h, [description]),
			]),
			...(hasDocs ? [docsLink(h, "kubernetes")] : []),
		],
		"py-24",
	)

/** `ServiceLensIndexPage`: nothing picked yet. */
const pickAService = (h: H, model: Model): Html => {
	const rail = railState(model.rail)
	return !rail.isLoading && rail.services.length === 0
		? lensEmpty(
				h,
				"No linked services",
				"No services are linked to Kubernetes workloads yet. The Helm chart's k8sattributes processor tags spans with their workload.",
				true,
			)
		: lensEmpty(
				h,
				"Pick a service",
				"This view answers one question: whether Kubernetes is why a service got slow. It needs a service to ask it about. The rail is sorted worst-first.",
				false,
			)
}

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					actions: Frame.controls(h, model.frame, { search: model.search, defaultPreset: DEFAULT_PRESET }, toFrame),
					tabs: kubernetesViewTabs(h, "services", model.search),
					filters: lensRail(h, model.rail, model.serviceName ?? undefined, model.search),
					filtersWidth: "w-72",
				},
				[model.serviceName === null ? pickAService(h, model) : lensBody(h, model, model.serviceName, inputs)],
			),
		],
	),
)
