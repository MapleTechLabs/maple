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
import { button } from "@maple/views/ui/button"
import { delta } from "@maple/views/ui/delta"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon, type IconName } from "@maple/views/ui/icon"
import { item, itemActions, itemContent, itemDescription, itemTitle } from "@maple/views/ui/item"
import { meter } from "@maple/views/ui/meter"
import { pressable } from "@maple/views/ui/pressable"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { serviceDot } from "@maple/views/ui/values"
import { pickTimeSearch } from "../../infra/kit/view-tabs"
import { type RuntimeLink, runtimeLink, workloadLink } from "../../kit/service-runtimes"
import { type DependencyKind, type StripTarget, stripTargets } from "./derive-panels"
import { Message } from "./message"
import type { Model, UsageTotals } from "./model"
import { sectionCard, viewAllButton } from "./view-panels"
import { dividedList } from "@maple/views/ui/rule"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// `ServiceUsagePanel`, `ServiceWorkloadsPanel` and `ServiceDependencyStrip` (components/services/).

type H = HtmlBuilder<Message>

const allEnvironments = (h: H): Html => typography(h, { size: "3xs", tone: "subtle" }, ["all environments"])

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
				Arr.map(USAGE_STATS, (stat) =>
					vstack(h, { gap: "0.5", className: "px-4 py-3", attributes: [h.Key(stat.key)] }, [
						eyebrow(h, {}, [stat.label]),
						typography(
							h,
							{
								size: "lg",
								tone: "foreground",
								weight: "semibold",
								mono: true,
								numeric: true,
								className: "leading-tight",
							},
							[stat.format(totals[stat.key])],
						),
						delta(h, {
							current: totals[stat.key],
							previous: previous?.[stat.key],
							suffix: "vs prev",
							flatThreshold: 0.005,
							className: typographyClass({ size: "3xs", tone: "muted" }),
						}),
					]),
				),
			),
		],
	)
}

/** `MeterRow`: label lane, the utilisation bar, the value lane. */
const meterRow = (h: H, label: string, fraction: number): Html => {
	const finite = Number.isFinite(fraction)
	const clamped = finite ? Math.max(0, Math.min(1, fraction)) : 0
	const level = severityLevel(clamped)
	return hstack(h, { gap: "2", align: "center", className: "leading-none", attributes: [h.Key(label)] }, [
		h.span(
			[h.Class(cn("w-8", "shrink-0 font-mono text-3xs tracking-wider text-foreground-subtle"))],
			[label],
		),
		meter(h, {
			value: clamped,
			className: "h-[3px] flex-1 rounded-2xs",
			fillClassName: BAR_FILL[level],
		}),
		h.span(
			[
				h.Class(
					cn("w-9", "shrink-0 text-right font-mono text-2xs tabular-nums", BAR_VALUE_TONE[level]),
				),
			],
			[finite ? formatPercent(fraction) : EMPTY_VALUE],
		),
	])
}

const runsOnRow = (
	h: H,
	link: RuntimeLink,
	extra: { readonly count?: string; readonly meters: ReadonlyArray<Html> },
): Html =>
	item(h, { variant: "flush", className: "gap-x-3 gap-y-1.5 px-4 py-2.5" }, [
		h.a(
			[
				h.Href(link.href),
				h.Class(
					"group flex min-w-0 flex-1 items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				),
			],
			[
				icon(h, link.icon, { size: 14, className: "shrink-0" }),
				itemContent(
					h,
					[
						itemTitle(
							h,
							[link.name],
							"block truncate font-mono text-xs font-normal text-foreground group-hover:text-primary",
						),
						itemDescription(
							h,
							[Arr.join([link.label, ...link.location], " · ")],
							typographyClass({ size: "3xs", tone: "subtle", truncate: true }),
						),
					],
					"gap-0 leading-tight",
				),
			],
		),
		...(extra.count === undefined
			? []
			: [
					itemActions(
						h,
						[extra.count],
						typographyClass({
							size: "2xs",
							tone: "muted",
							mono: true,
							numeric: true,
							className: "shrink-0",
						}),
					),
				]),
		...(extra.meters.length === 0
			? []
			: [
					h.div(
						[h.Class(cn(vstackClass({ gap: "1" }), "max-w-[280px] basis-full pl-6"))],
						extra.meters,
					),
				]),
	])

/** Every place the service runs, platform resources first: the header links the first. */
export const runsOnLinks = (model: Model): ReadonlyArray<RuntimeLink> => {
	const time = pickTimeSearch(model.search)
	return [
		...Arr.map(
			AsyncData.getOrElse(model.runtimes.data, () => []),
			(runtime) => runtimeLink(runtime, time),
		),
		...Arr.map(
			AsyncData.getOrElse(model.workloads.data, () => []),
			(workload) => workloadLink(workload, time),
		),
	]
}

/** Where the service runs: its platform resources, then its Kubernetes workloads. Nothing while empty. */
export const runsOnPanel = (h: H, model: Model, envFilterActive: boolean): Html => {
	const runtimes = AsyncData.getOrElse(model.runtimes.data, () => [])
	const workloads = AsyncData.getOrElse(model.workloads.data, () => [])
	if (runtimes.length === 0 && workloads.length === 0) return null
	const time = pickTimeSearch(model.search)
	return sectionCard(
		h,
		{
			title: "Runs on",
			action: envFilterActive ? allEnvironments(h) : undefined,
			className: refreshingClass(
				AsyncData.isRefreshing(model.runtimes.data) || AsyncData.isRefreshing(model.workloads.data),
			),
		},
		[
			dividedList(h, { as: "ul", bordered: false }, [
				...Arr.map(runtimes, (runtime) => {
					const link = runtimeLink(runtime, time)
					return h.keyed("li")(link.key, [], [runsOnRow(h, link, { meters: [] })])
				}),
				...Arr.map(workloads, (workload) => {
					const link = workloadLink(workload, time)
					const meters = [
						...(workload.avgCpuLimitUtilization === null
							? []
							: [meterRow(h, "CPU", workload.avgCpuLimitUtilization)]),
						...(workload.avgMemoryLimitUtilization === null
							? []
							: [meterRow(h, "MEM", workload.avgMemoryLimitUtilization)]),
					]
					return h.keyed("li")(
						link.key,
						[],
						[runsOnRow(h, link, { count: countLabel(workload.podCount, "pod"), meters })],
					)
				}),
			]),
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
	"inline-flex max-w-[220px] items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-xs hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

const stripChip = (h: H, target: StripTarget, onClick: Message): Html =>
	target.kind === "service"
		? h.a(
				[
					h.Key(target.id),
					h.Href(hrefOf(AppRoute.Service({ serviceName: target.name, search: {} }))),
					h.Class(CHIP),
				],
				[
					serviceDot(h, { serviceName: target.name }),
					typography(h, { truncate: true }, [target.name]),
				],
			)
		: pressable(
				h,
				{ onClick, className: cn(CHIP, "text-muted-foreground"), attributes: [h.Key(target.id)] },
				[
					icon(h, KIND_ICON.get(target.kind) ?? "GlobeIcon", { size: 12 }),
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
			...Arr.map(visible, (target) => stripChip(h, target, onViewAll)),
			...(hiddenCount > 0
				? [
						button(
							h,
							{
								variant: "dashed",
								size: "xs",
								// Sized like the chips it follows, not like a toolbar button.
								className: "h-auto py-0.5 text-xs font-normal sm:h-auto",
								attributes: [h.OnClick(onViewAll)],
							},
							[`+${hiddenCount} more`],
						),
					]
				: []),
			viewAllButton(h, onViewAll),
		],
	)
}
