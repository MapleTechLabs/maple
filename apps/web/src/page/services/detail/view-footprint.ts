import { severityLevel } from "../../infra/kit/format"
import { BAR_FILL, BAR_VALUE_TONE } from "../../kit/severity-tokens"
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
import { serviceLabel } from "@maple/views/ui/service-label"
import { pickTimeSearch } from "../../kit/view-tabs"
import { type RuntimeLink, runtimeLink, workloadLink } from "../../kit/service-runtimes"
import { type DependencyKind, type StripTarget, stripTargets } from "./derive-panels"
import { Message } from "./message"
import type { Model, UsageTotals } from "./model"
import { sectionCard, viewAllButton } from "./view-panels"
import { dividedList } from "@maple/views/ui/rule"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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

/** The window's ingest as four figures; nothing while loading, on error or with no data. */
const usageBody = (h: H, model: Model): Html => {
	const usage = AsyncData.getOrElse(model.usage.data, () => null)
	if (usage === null) return null
	const { totals, previous } = usage
	if (totals.logs === 0 && totals.traces === 0 && totals.metrics === 0 && totals.dataSize === 0) return null
	return h.div(
		[h.Class("grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4")],
		Arr.map(USAGE_STATS, (stat) =>
			vstack(h, { gap: "0.5", attributes: [h.Key(stat.key)] }, [
				typography(h, { size: "2xs", tone: "muted" }, [stat.label]),
				typography(
					h,
					{ size: "sm", tone: "foreground", weight: "medium", mono: true, numeric: true },
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
	)
}

/** `MeterRow`: label lane, the utilisation bar, the value lane. */
const meterRow = (h: H, label: string, fraction: number): Html => {
	const finite = Number.isFinite(fraction)
	const clamped = finite ? Math.max(0, Math.min(1, fraction)) : 0
	const level = severityLevel(clamped)
	return hstack(h, { gap: "2", align: "center", className: "leading-none", attributes: [h.Key(label)] }, [
		h.span(
			[h.Class(cn("w-8", "shrink-0 font-mono text-3xs tracking-caption text-foreground-subtle"))],
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

/** Where the service runs: its platform resources, then its Kubernetes workloads. Nothing while empty. */
const runsOnBody = (h: H, model: Model): Html => {
	const runtimes = AsyncData.getOrElse(model.runtimes.data, () => [])
	const workloads = AsyncData.getOrElse(model.workloads.data, () => [])
	if (runtimes.length === 0 && workloads.length === 0) return null
	const time = pickTimeSearch(model.search)
	return dividedList(h, { as: "ul", bordered: false, className: "-mx-4" }, [
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
	])
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
				[serviceLabel(h, { serviceName: target.name })],
			)
		: pressable(
				h,
				{ onClick, className: cn(CHIP, "text-muted-foreground"), attributes: [h.Key(target.id)] },
				[
					icon(h, KIND_ICON.get(target.kind) ?? "GlobeIcon", { size: 12 }),
					truncatedText(h, { text: target.name }),
				],
			)

/** The busiest downstream targets as one row of chips; quiet while empty. */
const talksToBody = (h: H, model: Model): Html => {
	const targets = AsyncData.getOrElse(AsyncData.map(model.dependencies.data, stripTargets), () => [])
	if (targets.length === 0) return null
	const visible = targets.slice(0, STRIP_LIMIT)
	const hiddenCount = targets.length - visible.length
	const onViewAll = Message.ClickedTab({ tab: "dependencies" })
	return hstack(h, { wrap: true, className: "gap-x-2 gap-y-1.5" }, [
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
	])
}

const footprintSection = (h: H, title: string, action: Html | undefined, body: Html): Html =>
	body === null
		? null
		: vstack(h, { gap: "2.5", className: "px-4 py-3", attributes: [h.Key(title)] }, [
				hstack(h, { gap: "2", justify: "between" }, [
					eyebrow(h, {}, [title]),
					...(action === undefined ? [] : [action]),
				]),
				body,
			])

/**
 * Where the service runs, what it calls and what it sends: one quiet card under the triage
 * panels, since none of it says whether the service is healthy. Nothing while all three are empty.
 */
export const footprintPanel = (h: H, model: Model, envFilterActive: boolean): Html => {
	const scope = envFilterActive ? allEnvironments(h) : undefined
	const sections = Arr.filter(
		[
			footprintSection(h, "Runs on", scope, runsOnBody(h, model)),
			footprintSection(
				h,
				"Talks to",
				viewAllButton(h, Message.ClickedTab({ tab: "dependencies" })),
				talksToBody(h, model),
			),
			footprintSection(h, "Ingest this window", scope, usageBody(h, model)),
		],
		(section) => section !== null,
	)
	if (sections.length === 0) return null
	const isWaiting =
		AsyncData.isRefreshing(model.usage.data) ||
		AsyncData.isRefreshing(model.dependencies.data) ||
		AsyncData.isRefreshing(model.runtimes.data) ||
		AsyncData.isRefreshing(model.workloads.data)
	return sectionCard(h, { title: "Footprint", className: refreshingClass(isWaiting) }, [
		dividedList(h, { as: "div", bordered: false }, sections),
	])
}
