import type { V2Source } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { emptyValue } from "@maple/views/ui/values"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { searchInput } from "@maple/views/ui/search-input"
import { skeleton } from "@maple/views/ui/skeleton"
import {
	ROW_LINK_LIFT,
	rowNameLink,
	table,
	tableBody,
	tableCell,
	tableGroupRow,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { listToolbar, toolbarStat } from "../../kit/list-toolbar"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { platformMeta, platformTile } from "../kit/platforms"
import type { SourceId } from "@maple/primitives"
import { sourceHref } from "../kit/shared"
import { rollupLabel, sourceStatusBadge } from "../kit/status"
import { signalCounts, type VolumeTotals, volumeSize } from "../kit/volume"
import { groupSources, matchesSearch, sourceKindLine } from "./groups"
import { cn } from "@maple/ui/lib/utils"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** `outline` keeps one filled CTA on the page when the empty state shows its own. */
const connectButton = (h: H, variant?: "outline"): Html =>
	linkButton(h, { size: "sm", href: "/sources/new", variant }, [
		icon(h, "PlusIcon", {
			attributes: [h.DataAttribute("icon", "inline-start")],
			className: variant === "outline" ? "text-primary" : undefined,
		}),
		"Connect source",
	])

const hasNoAddedSources = (rows: ReadonlyArray<V2Source>): boolean =>
	Arr.every(rows, (source) => source.is_default)

/** Mirrors `body`: the empty state renders once the list loaded with no added sources. */
const showsEmptyState = (model: Model): boolean =>
	model.nowMs !== null &&
	AsyncData.match(model.list.data, {
		onIdle: () => false,
		onLoading: () => false,
		onFailure: () => false,
		onStale: () => false,
		onSuccess: hasNoAddedSources,
		onRefreshing: hasNoAddedSources,
	})

/** Volume by source id: `null` while the summary loads, empty when it failed. */
type UsageBySource = ReadonlyMap<SourceId, VolumeTotals> | null

const usageBySource = (model: Model): UsageBySource =>
	AsyncData.isFailure(model.usage.data)
		? new Map()
		: Option.match(AsyncData.getData(model.usage.data), {
				onNone: () => null,
				onSome: (summary) => new Map(Arr.map(summary.data, (entry) => [entry.source_id, entry])),
			})

const NO_VOLUME: VolumeTotals = { spans: 0, logs: 0, metrics: 0, bytes: 0 }

const COLUMN_COUNT = 3

/** The row's first cell: the source's mark, its name as the row's link (stretched over the row), and what it is. */
const sourceCell = (h: H, source: V2Source): Html =>
	tableCell(h, [
		hstack(h, { gap: "3", shrink: true }, [
			platformTile(h, platformMeta(source.platform), "sm"),
			vstack(h, { gap: "0.5", shrink: true }, [
				rowNameLink(h, { href: sourceHref(source), name: source.name }),
				typography(h, { size: "xs", tone: "muted", truncate: true }, [sourceKindLine(source)]),
			]),
		]),
	])

/**
 * Resume acts in place. It sits above the row's link, so a click on it (even while it is disabled
 * mid-request) never opens the source.
 */
const resume = (h: H, model: Model, source: V2Source): ReadonlyArray<Html> =>
	source.status === "paused" && !source.is_default && canManage(model)
		? [
				h.span(
					[h.Class(cn("shrink-0", ROW_LINK_LIFT))],
					[
						button(
							h,
							{
								size: "xs",
								variant: "ghost",
								isLoading: model.resuming === source.id,
								// One resume at a time: the others wait for the list to come back.
								isDisabled: model.resuming !== null,
								attributes: [
									h.AriaLabel(`Resume: ${source.name}`),
									h.OnClick(Message.ClickedResume({ id: source.id })),
								],
							},
							["Resume"],
						),
					],
				),
			]
		: []

/** The state as the source page's header says it; under it, the reason or how many of its parts are unhealthy. */
const statusCell = (h: H, model: Model, source: V2Source, clock: Clock): Html => {
	const parts = Arr.filter([rollupLabel(source), source.health.problem], (part) => part !== null)
	const detail = parts.length === 0 ? null : Arr.join(parts, " · ")
	return tableCell(h, [
		hstack(h, { gap: "3", justify: "between", shrink: true }, [
			vstack(h, { gap: "0.5", shrink: true }, [
				sourceStatusBadge(h, source, { ...clock, hideRollup: true }),
				...(detail === null
					? []
					: [
							typography(
								h,
								{
									size: "xs",
									tone: "muted",
									truncate: true,
									attributes: [h.Title(detail)],
								},
								[detail],
							),
						]),
			]),
			...resume(h, model, source),
		]),
	])
}

/** The size is dropped below `md`, inside the cell: hiding a whole column would leave the label rows a column too wide. */
const SIZE_TEXT = "hidden md:inline"

/** What the source stored. Its per-signal counts are its name and tooltip; the source page shows them in full. */
const size = (h: H, source: V2Source, usage: UsageBySource, isUnavailable: boolean): Html => {
	if (isUnavailable) return emptyValue(h, SIZE_TEXT)
	if (usage === null) return skeleton(h, "hidden h-4 w-14 md:block")
	const totals = usage.get(source.id) ?? NO_VOLUME
	return typography(
		h,
		{
			tone: "foreground",
			numeric: true,
			className: SIZE_TEXT,
			attributes: [
				h.Title(signalCounts(totals)),
				h.AriaLabel(`${volumeSize(totals)} stored in the last 24 hours: ${signalCounts(totals)}`),
			],
		},
		[volumeSize(totals)],
	)
}

/** The row's end: what it stored, then the chevron that says the row opens. */
const trailingCell = (h: H, source: V2Source, usage: UsageBySource, isUnavailable: boolean): Html =>
	tableCell(h, [
		hstack(h, { gap: "4", justify: "end" }, [
			size(h, source, usage, isUnavailable),
			icon(h, "ChevronRightIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
		]),
	])

const sourceRow = (
	h: H,
	model: Model,
	source: V2Source,
	clock: Clock,
	usage: UsageBySource,
	isUnavailable: boolean,
): Html =>
	tableRow(
		h,
		[
			sourceCell(h, source),
			statusCell(h, model, source, clock),
			trailingCell(h, source, usage, isUnavailable),
		],
		undefined,
		[h.Key(source.id)],
	)

/** A thin label row over its sources; nothing at all while the group has none. */
const group = (h: H, title: string, rows: ReadonlyArray<Html>): ReadonlyArray<Html> =>
	rows.length === 0
		? []
		: [
				tableGroupRow(h, { colSpan: COLUMN_COUNT, key: `group-${title}` }, [
					typography(h, { size: "xs", tone: "muted" }, [
						typography(h, { tone: "foreground", weight: "medium" }, [title]),
						` · ${rows.length}`,
					]),
				]),
				...rows,
			]

const emptyState = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "ConnectionIcon", { size: 16 })]),
				emptyTitle(h, [canManage(model) ? "Connect your first source" : "No sources added yet"]),
				emptyDescription(h, [
					canManage(model)
						? "Give each SDK, cluster or host its own source to see what it sends, cap its rate, or pause it on its own."
						: "Org admins and engineers can connect sources.",
				]),
			]),
			...(canManage(model) ? [connectButton(h)] : []),
		],
		"py-8",
	)

/** "1.2 GB stored in the last 24h": listed sources only, so a deleted one stops counting. */
const orgTotal = (
	h: H,
	sources: ReadonlyArray<V2Source>,
	usage: UsageBySource,
	isUnavailable: boolean,
): Html | null => {
	if (usage === null || isUnavailable) return null
	const totals = Arr.reduce(sources, NO_VOLUME, (sum, source) => {
		const entry = usage.get(source.id) ?? NO_VOLUME
		return {
			spans: sum.spans + entry.spans,
			logs: sum.logs + entry.logs,
			metrics: sum.metrics + entry.metrics,
			bytes: sum.bytes + entry.bytes,
		}
	})
	return toolbarStat(h, {
		value: volumeSize(totals),
		label: "stored in the last 24h",
		attributes: [h.Title(signalCounts(totals))],
	})
}

const SEARCH_ID = "sources-search"

const toolbar = (h: H, model: Model, total: Html | null): Html =>
	listToolbar(h, {
		className: "pb-0",
		leading: searchInput(h, {
			id: SEARCH_ID,
			value: model.search,
			placeholder: "Search sources…",
			ariaLabel: "Search sources",
			className: "w-64",
			onInput: (value) => Message.ChangedSearch({ value }),
			onClear: Message.ChangedSearch({ value: "" }),
		}),
		trailing: total === null ? [] : [total],
	})

/** One table: what to fix, what is sending and what is not, each under its label row. */
const sourceGroups = (h: H, model: Model, rows: ReadonlyArray<V2Source>, clock: Clock): Html => {
	const usage = usageBySource(model)
	const isUnavailable = AsyncData.isFailure(model.usage.data)
	const hasAdded = !hasNoAddedSources(rows)
	const all = groupSources(rows, usage)
	const rowsOf = (sources: ReadonlyArray<V2Source>) =>
		Arr.map(
			Arr.filter(sources, (source) => matchesSearch(source, model.search)),
			(source) => sourceRow(h, model, source, clock, usage, isUnavailable),
		)
	const groups = [
		...group(h, "Needs attention", rowsOf(all.attention)),
		...group(h, "Receiving", rowsOf(all.receiving)),
		...group(h, "Not sending", rowsOf(all.idle)),
	]
	return vstack(h, { gap: "4" }, [
		// One source needs no search and has no total worth a line of its own.
		...(hasAdded ? [toolbar(h, model, orgTotal(h, rows, usage, isUnavailable))] : []),
		...(groups.length === 0
			? []
			: [
					table(h, { variant: "card", className: "table-fixed", ariaLabel: "Sources" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Source"]),
								tableHead(h, ["Status"], "w-40 sm:w-64 lg:w-80"),
								tableHead(
									h,
									[typography(h, { className: SIZE_TEXT }, ["Last 24h"])],
									"w-10 text-right md:w-36 md:pr-10",
								),
							]),
						]),
						tableBody(h, groups),
					]),
				]),
		...(groups.length === 0 && rows.length > 0
			? [
					filteredEmpty(h, {
						noun: "sources",
						title: "No sources match",
						description: "",
						onClear: Message.ChangedSearch({ value: "" }),
						clearLabel: "Clear search",
						className: "py-10 md:py-12",
					}),
				]
			: []),
		...(hasAdded ? [] : [emptyState(h, model)]),
	])
}

const failed = (h: H, failure: Parameters<typeof errorState>[1]["failure"]): Html =>
	errorState(h, { failure, title: "Couldn't load sources", onRetry: Message.ClickedRetry() })

const body = (h: H, model: Model, timeZone: string): Html => {
	const loading = skeleton(h, "h-48 w-full")
	const nowMs = model.nowMs
	if (nowMs === null) return loading
	return AsyncData.match(model.list.data, {
		onIdle: () => loading,
		onLoading: () => loading,
		onFailure: (failure) => failed(h, failure),
		onStale: ({ error }) => failed(h, error),
		onSuccess: (rows) => sourceGroups(h, model, rows, { nowMs, timeZone }),
		onRefreshing: (rows) => sourceGroups(h, model, rows, { nowMs, timeZone }),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			title: "Sources",
			actions: canManage(model)
				? connectButton(h, showsEmptyState(model) ? "outline" : undefined)
				: undefined,
		},
		[body(h, model, inputs.context.timeZone)],
	),
)
