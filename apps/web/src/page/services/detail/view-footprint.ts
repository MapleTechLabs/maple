import { severityLevel } from "../../../components/infra/format"
import { BAR_FILL, BAR_VALUE_TONE } from "../../../components/infra/severity-tokens"
import {
	countLabel,
	EMPTY_VALUE,
	formatNumber,
	formatPercent,
	formatStorageBytes,
} from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { delta } from "../../../ui/delta"
import { eyebrow } from "../../../ui/eyebrow"
import { icon, type IconName } from "../../../ui/icon"
import { item, itemActions, itemContent, itemDescription, itemTitle } from "../../../ui/item"
import { meter } from "../../../ui/meter"
import { truncatedText } from "../../../ui/truncated-text"
import { serviceDot } from "../../../ui/values"
import { type DependencyKind, type StripTarget, stripTargets } from "./derive-panels"
import { Message } from "./message"
import type { Model, UsageTotals, Workload } from "./model"
import { sectionCard, viewAllButton } from "./view-panels"

// `ServiceUsagePanel`, `ServiceWorkloadsPanel` and `ServiceDependencyStrip` (components/services/).

type H = HtmlBuilder<Message>

const allEnvironments = (h: H): Html =>
	h.span([h.Class("text-3xs text-muted-foreground/60")], ["all environments"])

const USAGE_STATS: ReadonlyArray<{
	readonly key: keyof UsageTotals
	readonly label: string
	readonly format: (value: number) => string
}> = [
	{ key: "logs", label: "Logs", format: formatNumber },
	{ key: "traces", label: "Spans", format: formatNumber },
	{ key: "metrics", label: "Metrics", format: formatNumber },
	{ key: "dataSize", label: "Stored", format: formatStorageBytes },
]

/** `ServiceUsagePanel`: nothing while loading, on error or with no data. */
export const usagePanel = (h: H, model: Model, envFilterActive: boolean): Html => {
	const usage = AsyncData.getOrElse(model.usage.data, () => null)
	if (usage === null) return null
	const { totals, previous } = usage
	if (totals.logs === 0 && totals.traces === 0 && totals.metrics === 0 && totals.dataSize === 0) return null
	return sectionCard(
		h,
		{
			title: "Ingest this window",
			action: envFilterActive ? allEnvironments(h) : undefined,
			className: refreshingClass(AsyncData.isRefreshing(model.usage.data)),
		},
		[
			h.div(
				[h.Class("grid grid-cols-2 gap-px sm:grid-cols-4")],
				USAGE_STATS.map((stat) =>
					h.div(
						[h.Key(stat.key), h.Class("flex flex-col gap-0.5 px-4 py-3")],
						[
							eyebrow(h, {}, [stat.label]),
							h.span(
								[h.Class("font-mono text-lg leading-tight tabular-nums text-foreground")],
								[stat.format(totals[stat.key])],
							),
							delta(h, {
								current: totals[stat.key],
								previous: previous?.[stat.key],
								suffix: "vs prev",
								flatThreshold: 0.005,
								className: "text-3xs text-muted-foreground",
							}),
						],
					),
				),
			),
		],
	)
}

const KIND_LABEL = new Map<Workload["workloadKind"], string>([
	["deployment", "Deployment"],
	["statefulset", "StatefulSet"],
	["daemonset", "DaemonSet"],
	["unknown", "Workload"],
])

/** `MeterRow`: label lane, the utilisation bar, the value lane. */
const meterRow = (h: H, label: string, fraction: number): Html => {
	const finite = Number.isFinite(fraction)
	const clamped = finite ? Math.max(0, Math.min(1, fraction)) : 0
	const level = severityLevel(clamped)
	return h.div(
		[h.Key(label), h.Class("flex items-center gap-2 leading-none")],
		[
			h.span(
				[
					h.Class(
						cn("w-8", "shrink-0 font-mono text-3xs tracking-wider text-muted-foreground/70"),
					),
				],
				[label],
			),
			meter(h, {
				value: clamped,
				className: "h-[3px] flex-1 rounded-[1px]",
				fillClassName: BAR_FILL[level],
			}),
			h.span(
				[
					h.Class(
						cn(
							"w-9",
							"shrink-0 text-right font-mono text-2xs tabular-nums",
							BAR_VALUE_TONE[level],
						),
					),
				],
				[finite ? formatPercent(fraction) : EMPTY_VALUE],
			),
		],
	)
}

/** `ServiceWorkloadsPanel`: nothing while loading, on error or without k8s context. */
export const workloadsPanel = (h: H, model: Model, envFilterActive: boolean): Html => {
	const workloads = AsyncData.getOrElse(model.workloads.data, () => [])
	if (workloads.length === 0) return null
	return sectionCard(
		h,
		{
			title: "Kubernetes",
			action: envFilterActive ? allEnvironments(h) : undefined,
			className: refreshingClass(AsyncData.isRefreshing(model.workloads.data)),
		},
		[
			h.ul(
				[h.Class("divide-y")],
				workloads.map((workload) => {
					const meters = [
						...(workload.avgCpuLimitUtilization === null
							? []
							: [meterRow(h, "CPU", workload.avgCpuLimitUtilization)]),
						...(workload.avgMemoryLimitUtilization === null
							? []
							: [meterRow(h, "MEM", workload.avgMemoryLimitUtilization)]),
					]
					return item(
						h,
						{ tag: "li", variant: "flush", className: "gap-x-3 gap-y-1.5 px-4 py-2.5" },
						[
							itemContent(
								h,
								[
									itemTitle(
										h,
										[workload.workloadName],
										"block truncate font-mono text-xs font-normal text-foreground",
									),
									itemDescription(
										h,
										[
											KIND_LABEL.get(workload.workloadKind) ?? "Workload",
											" · ",
											workload.namespace,
											...(workload.clusterName ? [` · ${workload.clusterName}`] : []),
										],
										"truncate text-3xs text-muted-foreground/60",
									),
								],
								"gap-0 leading-tight",
							),
							itemActions(
								h,
								[countLabel(workload.podCount, "pod")],
								"shrink-0 font-mono text-2xs tabular-nums text-muted-foreground",
							),
							...(meters.length === 0
								? []
								: [
										h.div(
											[h.Class(cn("flex flex-col gap-1", "max-w-[280px] basis-full"))],
											meters,
										),
									]),
						],
					)
				}),
			),
		],
	)
}

const KIND_ICON = new Map<DependencyKind, IconName>([
	["database", "DatabaseIcon"],
	["http", "GlobeIcon"],
	["messaging", "PaperPlaneIcon"],
	["rpc", "NetworkNodesIcon"],
])

const STRIP_LIMIT = 8
const CHIP =
	"inline-flex max-w-[220px] items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

const stripChip = (h: H, target: StripTarget, onClick: Message): Html =>
	target.kind === "service"
		? h.a(
				[
					h.Key(target.id),
					h.Href(hrefOf(AppRoute.Service({ serviceName: target.name, search: {} }))),
					h.Class(CHIP),
				],
				[serviceDot(h, { serviceName: target.name }), h.span([h.Class("truncate")], [target.name])],
			)
		: h.button(
				[
					h.Key(target.id),
					h.Type("button"),
					h.OnClick(onClick),
					h.Class(cn(CHIP, "text-muted-foreground")),
				],
				[
					icon(h, KIND_ICON.get(target.kind) ?? "GlobeIcon", { size: 11 }),
					truncatedText(h, { text: target.name }),
				],
			)

/** `ServiceDependencyStrip`: the busiest downstream targets as one row of chips; quiet while empty. */
export const dependencyStrip = (h: H, model: Model): Html => {
	const targets = AsyncData.getOrElse(AsyncData.map(model.dependencies.data, stripTargets), () => [])
	if (targets.length === 0) return null
	const visible = targets.slice(0, STRIP_LIMIT)
	const hiddenCount = targets.length - visible.length
	const isWaiting = AsyncData.isRefreshing(model.dependencies.data)
	const onViewAll = Message.ClickedTab({ tab: "dependencies" })
	return h.div(
		[
			h.Class(cn("flex flex-wrap items-center gap-x-2 gap-y-1.5", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			eyebrow(h, {}, ["Talks to"]),
			...visible.map((target) => stripChip(h, target, onViewAll)),
			...(hiddenCount > 0
				? [
						h.button(
							[
								h.Type("button"),
								h.OnClick(onViewAll),
								h.Class(
									"inline-flex items-center rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
								),
							],
							[`+${hiddenCount} more`],
						),
					]
				: []),
			viewAllButton(h, onViewAll),
		],
	)
}
