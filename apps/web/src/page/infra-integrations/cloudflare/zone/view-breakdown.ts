import type { CloudflareFilters } from "../../../../components/infra/cloudflare/filters"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatBytes, formatErrorRate, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../../ui/icon"
import { listFooter } from "../../../../ui/list-footer"
import { panel, panelHeader, panelTitle } from "../../../../ui/panel"
import { segmentedSelect } from "../../../../ui/segmented-select"
import { skeleton } from "../../../../ui/skeleton"
import { columnHead, dataTable, dataTableEmpty } from "../../../infra/kit/data-table"
import { type Sort, sortRowsByField } from "../../../kit/table-sort"
import type { BreakdownTotal, ZoneBreakdown } from "../data"
import { DIMENSIONS, type DimensionDef, dimensionOf } from "./derive"
import { type BreakdownSortKey, Message, type Model } from "./model"
import { SCOPE_IDS } from "./view-sections"
import { panelScope, type Trigger } from "./view-scope"

// `CloudflareBreakdownPanel`: one ranked table per dimension, rows filter the page, and a live Cloudflare
// lookup for the long tail.

type H = HtmlBuilder<Message>

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0 hover:bg-surface-sunken"
const MONO_LINK =
	"font-mono text-3xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"

const warehouseTimeToMs = (value: string) => new Date(`${value.replace(" ", "T")}Z`).getTime()

/** ISO-8601 UTC → "Jul 28" (`formatDateInTimezone` without the year). */
const formatCollectedFrom = (iso: string, timeZone: string): string | null =>
	Number.isNaN(new Date(iso).getTime())
		? null
		: new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(iso))

/** `shareBar`: the row's background filled to its share. */
const shareBarStyle = (share: number): Readonly<Record<string, string>> | undefined => {
	const pct = Math.min(100, share * 100)
	if (!Number.isFinite(pct) || pct < 0.5) return undefined
	const fill = "color-mix(in oklab, var(--primary) 14%, transparent)"
	return {
		"background-image": `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, transparent ${pct}%)`,
	}
}

/** `CompactFilterInput`: the 24px mono filter field. */
const compactFilterInput = (h: H, value: string, placeholder: string, label: string): Html =>
	h.label(
		[
			h.Class(
				"flex h-6 items-center gap-1.5 rounded-sm border border-border-subtle bg-background/60 px-2 transition-colors focus-within:border-ring min-w-0 max-w-xs flex-1",
			),
		],
		[
			icon(h, "MagnifierIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
			h.input([
				h.Type("search"),
				h.Value(value),
				h.OnInput((next) => Message.ChangedBreakdownSearch({ value: next })),
				h.Placeholder(placeholder),
				h.AriaLabel(label),
				h.Class(
					"min-w-0 flex-1 bg-transparent font-mono text-2xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden",
				),
			]),
			...(value === ""
				? []
				: [
						h.button(
							[
								h.Type("button"),
								h.AriaLabel("Clear filter"),
								h.OnClick(Message.ChangedBreakdownSearch({ value: "" })),
								h.Class(
									"inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3",
								),
							],
							[icon(h, "XmarkIcon")],
						),
					]),
		],
	)

const toolbar = (h: H, model: Model, dimension: DimensionDef, count: number, meta: Html | null): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pb-2")],
		[
			compactFilterInput(
				h,
				model.breakdownSearch,
				`Filter ${count} ${dimension.noun}`,
				`Filter the listed ${dimension.noun}`,
			),
			...(meta === null ? [] : [meta]),
		],
	)

const table = (
	h: H,
	options: Readonly<{
		dimension: DimensionDef
		rows: ReadonlyArray<BreakdownTotal>
		isWaiting: boolean
		emptyMessage: string
		sort: Sort<BreakdownSortKey>
		onSort: (key: BreakdownSortKey) => Message
		/** Live rows are not page filters: the warehouse has no slice for them. */
		selected: ReadonlyArray<string> | null
	}>,
): Html => {
	const sorted = sortRowsByField(options.rows, options.sort)
	const head = (label: string, key: BreakdownSortKey, width: string, hidden?: string) =>
		columnHead(h, {
			label,
			width,
			hidden,
			align: key === "key" ? "left" : "right",
			sort: { onSort: options.onSort(key), isActive: options.sort.key === key, dir: options.sort.dir },
		})
	const { dimension } = options
	return dataTable(
		h,
		{
			ariaLabel: `${dimension.column} breakdown`,
			isWaiting: options.isWaiting,
		},
		[
			head(dimension.column, "key", "w-0 flex-1 min-w-[220px]"),
			head("Requests", "requests", "w-28"),
			head("Error rate", "errorRate", "w-24"),
			head("Bandwidth", "bytes", "w-24", "hidden md:flex"),
		],
		sorted.length === 0
			? [dataTableEmpty(h, [options.emptyMessage])]
			: sorted.map((row) => {
					const label = row.key || EMPTY_VALUE
					const isSelected = options.selected?.includes(row.key) === true
					const style = shareBarStyle(row.share)
					return h.div(
						[
							h.Key(row.key),
							h.Class(ROW_CLASS),
							...(style === undefined ? [] : [h.Style(style)]),
						],
						[
							h.div(
								[h.Class("w-0 min-w-[220px] flex-1 truncate")],
								[
									options.selected === null
										? h.span(
												[
													h.Class(
														"block max-w-full truncate font-mono text-xs text-foreground",
													),
												],
												[label],
											)
										: h.button(
												[
													h.Type("button"),
													h.OnClick(
														Message.ToggledFilter({
															key: dimension.filterKey,
															value: row.key,
														}),
													),
													h.AriaPressed(String(isSelected)),
													h.Title(`Filter this page by ${label}`),
													h.Class(
														cn(
															"max-w-full truncate rounded-xs font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-1 focus-visible:outline-ring",
															isSelected ? "text-primary" : "text-foreground",
														),
													),
												],
												[label],
											),
								],
							),
							h.div(
								[
									h.Class(
										"w-28 text-right font-mono text-xs tabular-nums text-foreground-soft",
									),
									h.Title(`${formatPercent(row.share)} of listed requests`),
								],
								[formatNumber(row.requests)],
							),
							h.div(
								[
									h.Class(
										cn(
											"w-24 text-right font-mono text-xs tabular-nums",
											errorRateClass(row.errorRate),
										),
									),
								],
								[formatErrorRate(row.errorRate)],
							),
							h.div(
								[
									h.Class(
										"hidden w-24 text-right font-mono text-xs tabular-nums text-foreground-soft md:block",
									),
								],
								[formatBytes(row.bytes)],
							),
						],
					)
				}),
	)
}

/** The page filter a row click toggles, as the selected values. */
const selectedOf = (filters: CloudflareFilters, dimension: DimensionDef): ReadonlyArray<string> => {
	const value = filters[dimension.filterKey]
	return value === undefined || typeof value === "string" ? [] : value
}

const storedSkeleton = (h: H): Html =>
	h.div(
		[h.Class("space-y-2 px-3 pb-3")],
		[skeleton(h, "h-40 w-full"), skeleton(h, "h-4 w-5/6"), skeleton(h, "h-4 w-2/3")],
	)

const stored = (
	h: H,
	model: Model,
	dimension: DimensionDef,
	filters: CloudflareFilters,
	startTime: string,
	timeZone: string,
): Html => {
	const body = (data: ZoneBreakdown, isWaiting: boolean): Html => {
		const query = model.breakdownSearch.trim().toLowerCase()
		const collectedFrom =
			data.coverageStart !== null &&
			warehouseTimeToMs(startTime) < new Date(data.coverageStart).getTime() - 60_000
				? formatCollectedFrom(data.coverageStart, timeZone)
				: null
		const notCollected = data.coverageStart === null && data.totals.length === 0
		const matches =
			query === "" ? data.totals : data.totals.filter((row) => row.key.toLowerCase().includes(query))
		const canSearchLive = dimension.liveDimension !== undefined && model.breakdownSearch.trim() !== ""
		const footerExtras = [
			...(collectedFrom === null ? [] : [h.span([], ["collected from ", collectedFrom])]),
			...(canSearchLive
				? [
						h.button(
							[
								h.Type("button"),
								h.OnClick(Message.ClickedSearchLive()),
								h.Class(cn(MONO_LINK, "ml-auto")),
							],
							["Search all ", dimension.noun, " in Cloudflare"],
						),
					]
				: []),
		]
		const footer =
			data.totals.length === 0 && !canSearchLive
				? null
				: listFooter(h, {
						shown: matches.length,
						total: data.totals.length,
						noun: dimension.noun,
						align: "start",
						className: "justify-start gap-x-3 gap-y-1 px-3 py-2 font-mono text-3xs",
						children: footerExtras,
					})
		return h.div(
			[h.Class(refreshingClass(isWaiting)), ...(isWaiting ? [h.AriaBusy(true)] : [])],
			[
				toolbar(
					h,
					model,
					dimension,
					data.totals.length,
					// Below 99.5% the fold is actually hiding something; above it, saying so is noise.
					data.coverage < 0.995 && data.totals.length > 0
						? h.span(
								[h.Class("font-mono text-3xs text-muted-foreground")],
								[formatPercent(data.coverage), " of zone requests"],
							)
						: null,
				),
				table(h, {
					dimension,
					rows: matches,
					isWaiting,
					emptyMessage:
						query !== ""
							? `No listed ${dimension.noun} match "${model.breakdownSearch.trim()}".`
							: notCollected
								? `Not collected for this period. ${dimension.column} data starts once the poller has run.`
								: "No traffic in the selected window.",
					sort: model.breakdownSort,
					onSort: (key) => Message.ClickedBreakdownSort({ key }),
					selected: selectedOf(filters, dimension),
				}),
				...(footer === null ? [] : [footer]),
			],
		)
	}
	return AsyncData.match(model.breakdown.data, {
		onIdle: () => storedSkeleton(h),
		onLoading: () => storedSkeleton(h),
		onFailure: () => breakdownError(h, dimension),
		onStale: () => breakdownError(h, dimension),
		onSuccess: (data) => body(data, false),
		onRefreshing: (data) => body(data, true),
	})
}

const breakdownError = (h: H, dimension: DimensionDef): Html =>
	h.p(
		[h.Class("px-3 pb-3 font-mono text-2xs text-muted-foreground")],
		["Couldn't load the ", dimension.column.toLowerCase(), " breakdown."],
	)

const live = (h: H, model: Model, dimension: DimensionDef): Html => {
	const query = model.liveQuery ?? ""
	const liveMeta = h.span(
		[h.Class("font-mono text-3xs text-muted-foreground")],
		["Live from Cloudflare · no history"],
	)
	const note = (text: ReadonlyArray<string>) =>
		h.p([h.Class("px-3 pb-3 font-mono text-2xs text-muted-foreground")], text)
	return AsyncData.match(model.liveTraffic.data, {
		onIdle: () => liveLoading(h, model, dimension, liveMeta),
		onLoading: () => liveLoading(h, model, dimension, liveMeta),
		onFailure: () =>
			h.div(
				[],
				[
					toolbar(h, model, dimension, 0, liveMeta),
					note(["Couldn't reach Cloudflare's analytics API for this zone right now."]),
				],
			),
		onStale: () =>
			h.div(
				[],
				[
					toolbar(h, model, dimension, 0, liveMeta),
					note(["Couldn't reach Cloudflare's analytics API for this zone right now."]),
				],
			),
		onSuccess: (data) => liveBody(h, model, dimension, data, false, query, liveMeta),
		onRefreshing: (data) => liveBody(h, model, dimension, data, true, query, liveMeta),
	})
}

const liveLoading = (h: H, model: Model, dimension: DimensionDef, meta: Html): Html =>
	h.div(
		[],
		[
			toolbar(h, model, dimension, 0, meta),
			h.div(
				[h.Class("space-y-2 px-3 pb-3")],
				[skeleton(h, "h-4 w-full"), skeleton(h, "h-4 w-5/6"), skeleton(h, "h-4 w-2/3")],
			),
		],
	)

const liveBody = (
	h: H,
	model: Model,
	dimension: DimensionDef,
	data: Readonly<{ unavailableReason: string | null; rows: ReadonlyArray<Omit<BreakdownTotal, "share">> }>,
	isWaiting: boolean,
	query: string,
	meta: Html,
): Html => {
	if (data.unavailableReason !== null) {
		return h.div(
			[],
			[
				toolbar(h, model, dimension, 0, meta),
				h.p(
					[h.Class("px-3 pb-3 font-mono text-2xs text-muted-foreground")],
					["Cloudflare can't serve this breakdown: ", data.unavailableReason],
				),
			],
		)
	}
	const attributed = data.rows.reduce((sum, row) => sum + row.requests, 0)
	const rows = data.rows.map((row) => ({
		key: row.key,
		requests: row.requests,
		errors5xx: 0,
		bytes: row.bytes,
		errorRate: row.errorRate,
		share: attributed > 0 ? row.requests / attributed : 0,
	}))
	return h.div(
		[h.Class(refreshingClass(isWaiting)), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			toolbar(h, model, dimension, rows.length, meta),
			table(h, {
				dimension,
				rows,
				isWaiting,
				emptyMessage: `No ${dimension.noun} match "${query}" in this window.`,
				sort: model.liveSort,
				onSort: (key) => Message.ClickedLiveSort({ key }),
				selected: null,
			}),
			h.p(
				[h.Class("px-3 py-2 font-mono text-3xs text-muted-foreground")],
				[
					"Cloudflare's top ",
					String(rows.length),
					' for "',
					query,
					'" · clear the filter to return to stored data',
				],
			),
		],
	)
}

export const breakdownPanel = (
	h: H,
	model: Model,
	options: Readonly<{ filters: CloudflareFilters; startTime: string; timeZone: string; trigger: Trigger }>,
): Html => {
	const dimension = dimensionOf(model)
	const isLive = model.liveQuery !== null
	const ignoredFilters = AsyncData.isSuccess(model.breakdown.data)
		? model.breakdown.data.data.ignoredFilters
		: undefined
	const scope = panelScope(h, {
		filters: options.filters,
		ignoredFilters,
		reason: breakdownReason(dimension),
		id: SCOPE_IDS.breakdown,
		trigger: options.trigger,
	})
	return panel(h, { className: "overflow-visible" }, [
		panelHeader(h, {
			divided: false,
			className: "gap-y-2 px-3 pt-2.5 pb-2",
			action: segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Breakdown dimension",
				options: DIMENSIONS.map((d) => ({ value: d.id, label: d.tab })),
				value: model.dimension,
				onChange: (next) => Message.ClickedDimension({ dimension: next }),
			}),
			children: [
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						panelTitle(h, ["Breakdown"]),
						...(isLive
							? [
									h.button(
										[
											h.Type("button"),
											h.OnClick(Message.ClickedLeaveLive()),
											h.DataAttribute("slot", "badge"),
											h.Class(
												cn(
													badgeVariants({
														variant: "meta",
														size: "xs",
														mono: true,
														className:
															"bg-background/60 font-normal transition-colors hover:text-foreground",
													}),
												),
											),
										],
										["live", icon(h, "XmarkIcon")],
									),
								]
							: scope === undefined
								? []
								: [scope]),
					],
				),
			],
		}),
		isLive
			? live(h, model, dimension)
			: stored(h, model, dimension, options.filters, options.startTime, options.timeZone),
	])
}

export const breakdownReason = (dimension: DimensionDef) =>
	`This breakdown is grouped by ${dimension.column.toLowerCase()}`
