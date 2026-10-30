import type { CloudflareServiceUsage } from "@maple/domain/http"
import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../charts/chart"
import * as Sparkline from "../../charts/sparkline"
import { AppRoute, hrefOf } from "../../route"
import { button } from "../../ui/button"
import { emptyMessage } from "../../ui/empty"
import { panel, panelHeader } from "../../ui/panel"
import { searchInput } from "../../ui/search-input"
import { statusDot } from "../../ui/status-dot"
import { countChipItem } from "./kit/count-chip"
import * as ToggleGroup from "../../ui/toggle-group"
import { truncatedText } from "../../ui/truncated-text"
import { columnHead } from "../infra/kit/data-table"
import { CLOUDFLARE_ACCENT } from "./catalog"
import type { ZoneSortKey } from "./cloudflare"
import {
	CHIP_ORDER,
	rowHasData,
	type RowUsage,
	STATUS_META,
	type ZoneDetail,
	type ZoneEntry,
	type ZoneStatusInfo,
	type ZoneStatusKind,
	zoneStatus,
} from "./cloudflare-derive"
import { Message } from "./message"
import type { Model } from "./model"

// `CloudflareZoneBoard`, `ResourceRow`, `CountChip` and `CloudflareWorkersCard`.
// TODO(tooltip): the "Details" trigger renders; its popup with the raw error is the overlay port's.

type H = HtmlBuilder<Message>

const CHART_MODEL = Chart.init()

const detailView = (h: H, detail: ZoneDetail): ReadonlyArray<Html | string> =>
	detail._tag === "Text"
		? [detail.text]
		: [
				detail.summary === detail.raw
					? h.span([h.Class("line-clamp-2 break-words")], [detail.raw])
					: h.span(
							[h.Class("line-clamp-2 break-words")],
							[
								detail.summary,
								" ",
								h.span(
									[
										h.DataAttribute("base-ui-tooltip-trigger", ""),
										h.Class(
											"cursor-help font-medium underline decoration-dotted underline-offset-2",
										),
										h.DataAttribute("slot", "tooltip-trigger"),
									],
									["Details"],
								),
							],
						),
			]

const sparkline = (h: H, model: Model, name: string, usage: RowUsage): Html =>
	model.cloudflareCard.chartRuntime._tag !== "Ready" || usage.points.length < 2
		? h.empty
		: h.div(
				[h.Class("h-5 w-16")],
				[
					h.submodel({
						slotId: `cf-integration-spark-${name}`,
						model: CHART_MODEL,
						view: Sparkline.view,
						toParentMessage: (message: Chart.Message) => Message.GotSparklineMessage({ message }),
						viewInputs: {
							chartId: `cf-integration-spark-${name.replace(/\W+/g, "_")}`,
							values: usage.points,
							color: CLOUDFLARE_ACCENT,
							className: "h-full w-full",
							revision: 0,
							curve: "monotone",
							fillOpacity: [0.35, 0],
						},
					}),
				],
			)

const resourceRow = (
	h: H,
	model: Model,
	name: string,
	status: ZoneStatusInfo,
	usage: RowUsage | null,
	zoneLink: boolean,
): Html => {
	const hasData = rowHasData(usage)
	const body = [
		statusDot(h, { tone: status.tone, className: "mt-[5px]" }),
		h.div(
			[h.Class("min-w-0 flex-1")],
			[
				truncatedText(h, {
					text: name,
					className: cn(
						"text-xs font-medium text-foreground",
						zoneLink && "group-hover:text-primary",
					),
				}),
				h.div(
					[h.Class(cn("mt-0.5 text-2xs @lg:hidden", status.detailClass))],
					detailView(h, status.detail),
				),
			],
		),
		h.div(
			[
				h.Class(
					cn(
						"hidden w-[190px] min-w-0 shrink-0 self-center text-2xs @lg:block",
						status.detailClass,
					),
				),
			],
			detailView(h, status.detail),
		),
		h.div(
			[h.Class("flex w-[124px] shrink-0 items-center justify-end gap-2.5 self-center")],
			[
				...(hasData && usage !== null ? [sparkline(h, model, name, usage)] : []),
				h.span(
					[h.Class("w-12 text-right text-xs font-medium tabular-nums text-foreground")],
					[hasData && usage !== null ? formatNumber(usage.totalRequests) : EMPTY_VALUE],
				),
			],
		),
	]
	const rowClass =
		"group flex items-start gap-3 border-b border-border/60 px-3 py-2 transition-colors last:border-0"
	return zoneLink
		? h.a(
				[
					h.Href(hrefOf(AppRoute.InfraCloudflareZone({ zoneName: name, search: {} }))),
					h.Class(
						cn(
							rowClass,
							"hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
						),
					),
				],
				body,
			)
		: h.div([h.Class(rowClass)], body)
}

interface Decorated {
	readonly entry: ZoneEntry
	readonly status: ZoneStatusInfo
	readonly requests: number
}

const sortZones = (zones: ReadonlyArray<Decorated>, key: ZoneSortKey, dir: "asc" | "desc") =>
	zones.toSorted((a, b) => {
		const raw =
			key === "name"
				? a.entry.name.localeCompare(b.entry.name)
				: key === "requests"
					? a.requests - b.requests
					: STATUS_META[a.status.kind].order - STATUS_META[b.status.kind].order
		const primary = dir === "asc" ? raw : -raw
		return primary !== 0 ? primary : b.requests - a.requests
	})

export const zoneBoard = (
	h: H,
	model: Model,
	zones: ReadonlyArray<ZoneEntry>,
	usageLoaded: boolean,
	banner: Html | null,
	className: string,
): Html => {
	const card = model.cloudflareCard
	const decorated = zones.map((entry) => ({
		entry,
		status: zoneStatus(entry, usageLoaded, model.nowMs),
		requests: entry.usage?.totalRequests ?? 0,
	}))
	const counts = (kind: ZoneStatusKind) => decorated.filter((zone) => zone.status.kind === kind).length
	const filter = card.zoneFilter.values[0] ?? "all"
	const query = card.zoneSearch.trim().toLowerCase()
	const filtered = decorated.filter(
		(zone) =>
			(filter === "all" || zone.status.kind === filter) &&
			(query === "" || zone.entry.name.toLowerCase().includes(query)),
	)
	const sorted = sortZones(filtered, card.zoneSort.key, card.zoneSort.dir)
	const head = (
		label: string,
		key: ZoneSortKey,
		width: string,
		extra: Partial<{ align: "right"; hidden: string }>,
	) =>
		columnHead(h, {
			label,
			width,
			...extra,
			sort: {
				isActive: card.zoneSort.key === key,
				dir: card.zoneSort.dir,
				onSort: Message.ClickedZoneSort({ key }),
			},
		})
	return panel(h, { className: cn("@container border-border/60", className) }, [
		panelHeader(h, {
			className: "gap-2 border-border/60 pl-4 pr-2.5",
			children: [
				h.h3([h.Class("text-sm font-semibold")], ["Zones"]),
				ToggleGroup.view(h, {
					model: card.zoneFilter,
					toParentMessage: (message) => Message.GotZoneFilterMessage({ message }),
					isConnected: false,
					size: "xs",
					className: "ml-auto gap-1.5",
					items: [
						countChipItem(h, { value: "all", label: "All", count: decorated.length }),
						...CHIP_ORDER.filter((kind) => counts(kind) > 0).map((kind) =>
							countChipItem(h, {
								value: kind,
								label: STATUS_META[kind].label,
								count: counts(kind),
								tone: STATUS_META[kind].tone,
							}),
						),
					],
				}),
				searchInput(h, {
					id: "cloudflare-zone-search",
					className: "w-full sm:w-[170px]",
					value: card.zoneSearch,
					placeholder: "Filter zones…",
					onInput: (value) => Message.ChangedZoneSearch({ value }),
					onClear: Message.ChangedZoneSearch({ value: "" }),
					attributes: [h.AriaLabel("Filter zones by name")],
				}),
				button(
					h,
					{
						variant: "outline",
						size: "xs",
						isDisabled: !model.isAdmin,
						attributes: [
							h.OnClick(Message.ClickedManageZones()),
							...(model.isAdmin ? [] : [h.Title("Only org admins can change zones")]),
						],
					},
					["Manage zones"],
				),
			],
		}),
		...(banner === null ? [] : [h.div([h.Class("px-3 pt-3")], [banner])]),
		h.div(
			[h.Class("flex flex-col")],
			[
				h.div(
					[h.Class("flex items-center gap-3 border-b border-border/60 px-3 py-2")],
					[
						h.span([h.AriaHidden(true), h.Class("size-1.5 shrink-0")]),
						head("Zone", "name", "min-w-0 flex-1", {}),
						head("Status", "status", "w-[190px]", { hidden: "hidden @lg:flex" }),
						head("24h requests", "requests", "w-[124px]", { align: "right" }),
					],
				),
				sorted.length === 0
					? emptyMessage(h, { className: "px-3 py-10" }, [
							query !== ""
								? `No zones match "${card.zoneSearch.trim()}".`
								: "No zones in this state.",
						])
					: h.div(
							[h.Class("max-h-[22rem] overflow-y-auto overscroll-contain")],
							sorted.map((zone) =>
								resourceRow(
									h,
									model,
									zone.entry.name,
									zone.status,
									zone.entry.usage,
									zone.requests > 0,
								),
							),
						),
			],
		),
	])
}

const WORKERS_COLLAPSED_COUNT = 6

export const workersCard = (
	h: H,
	model: Model,
	workerEntry: ZoneEntry,
	workerServices: ReadonlyArray<CloudflareServiceUsage>,
	usageLoaded: boolean,
): Html => {
	const aggregate = zoneStatus(workerEntry, usageLoaded, model.nowMs)
	const scripts = workerServices.toSorted((a, b) => b.totalRequests - a.totalRequests)
	const expanded = model.cloudflareCard.workersExpanded
	const visible = expanded ? scripts : scripts.slice(0, WORKERS_COLLAPSED_COUNT)
	return panel(h, { className: "h-fit border-border/60 lg:w-72 lg:shrink-0 xl:w-80" }, [
		panelHeader(h, {
			className: "border-border/60 py-3",
			children: [h.h3([h.Class("text-sm font-semibold")], ["Workers"])],
			action: h.a(
				[
					h.Href(hrefOf(AppRoute.ServiceMap({ search: {} }))),
					h.Class("text-xs text-muted-foreground transition-colors hover:text-foreground"),
				],
				["View on map →"],
			),
		}),
		...(aggregate.kind === "issue" || aggregate.kind === "no-data"
			? [
					h.div(
						[h.Class(cn("border-b border-border/60 px-4 py-2 text-2xs", aggregate.detailClass))],
						detailView(h, aggregate.detail),
					),
				]
			: []),
		scripts.length === 0
			? h.div(
					[h.Class("flex items-center gap-2.5 px-4 py-3")],
					[
						statusDot(h, { tone: aggregate.tone }),
						h.span(
							[h.Class(cn("text-2xs", aggregate.detailClass))],
							detailView(h, aggregate.detail),
						),
					],
				)
			: h.div(
					[h.Class("flex flex-col px-4 pb-2 pt-1")],
					[
						...visible.map((service) =>
							h.div(
								[
									h.Class(
										"flex items-center justify-between gap-3 border-b border-border/60 py-2.5 last:border-0",
									),
								],
								[
									h.span(
										[h.Class("flex min-w-0 items-center gap-2.5")],
										[
											statusDot(h, {
												tone: service.totalRequests > 0 ? "ok" : "neutral",
											}),
											truncatedText(h, {
												text: service.displayName,
												className: "text-xs font-medium text-foreground",
											}),
										],
									),
									h.span(
										[
											h.Class(
												"shrink-0 text-xs font-medium tabular-nums text-foreground",
											),
										],
										[
											service.totalRequests > 0
												? formatNumber(service.totalRequests)
												: EMPTY_VALUE,
										],
									),
								],
							),
						),
						...(scripts.length > WORKERS_COLLAPSED_COUNT
							? [
									button(
										h,
										{
											variant: "link",
											size: "xs",
											className:
												"h-auto justify-start p-0 pb-1 pt-2.5 text-2xs font-normal text-muted-foreground hover:text-foreground",
											attributes: [h.OnClick(Message.ClickedWorkersExpand())],
										},
										[
											expanded
												? "Show fewer"
												: `Showing ${visible.length} of ${scripts.length} · View all →`,
										],
									),
								]
							: []),
					],
				),
	])
}
