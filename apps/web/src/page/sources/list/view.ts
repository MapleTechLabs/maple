import type { V2Source } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { emptyValue } from "@maple/views/ui/values"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { meter } from "@maple/views/ui/meter"
import { searchInput } from "@maple/views/ui/search-input"
import { skeleton } from "@maple/views/ui/skeleton"
import {
	numericTableCell,
	ROW_LINK_LIFT,
	rowNameLink,
	table,
	tableBody,
	tableCell,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { listToolbar, toolbarStat } from "../../kit/list-toolbar"
import { sectionHeading } from "../../kit/section-heading"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { platformMeta, platformTile } from "../kit/platforms"
import type { SourceId } from "@maple/primitives"
import type { SourceTab } from "../../../route/search"
import { integrationPlatformOf, pausedLabel, sourceHref } from "../kit/shared"
import { lastSeenWord, rollupLabel, sourceStatusLabel, statusTone } from "../kit/status"
import { signalCounts, type VolumeTotals, volumeSize } from "../kit/volume"
import { groupSources, matchesSearch, sourceKindLine } from "./groups"
import { cn } from "@maple/ui/lib/utils"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { relativeTime } from "../../kit/relative-time"

type H = HtmlBuilder<Message>
type Children = ReadonlyArray<Html | string>
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

/** A row's line under the name; `title` is its full text when it can be cut off. */
type RowLine = Readonly<{ children: Children; title?: string }>

/**
 * The row's first cell: the source's mark, its name as the row's link (stretched over the row),
 * and one line under it. It takes the width the other cells leave, so the name is cut last.
 */
const sourceCell = (h: H, source: V2Source, line: RowLine): Html =>
	truncatedTableCell(h, [
		hstack(h, { gap: "3", shrink: true }, [
			platformTile(h, platformMeta(source.platform), "sm"),
			vstack(h, { gap: "0.5", shrink: true }, [
				rowNameLink(h, { href: sourceHref(source), name: source.name }),
				typography(
					h,
					{
						size: "xs",
						tone: "muted",
						truncate: true,
						attributes: line.title === undefined ? [] : [h.Title(line.title)],
					},
					line.children,
				),
			]),
		]),
	])

const sourceRow = (h: H, source: V2Source, cells: ReadonlyArray<Html>): Html =>
	tableRow(h, cells, undefined, [h.Key(source.id)])

/** A titled group of rows; nothing at all while it has none. */
const group = (h: H, title: string, rows: ReadonlyArray<Html>): ReadonlyArray<Html> =>
	rows.length === 0
		? []
		: [
				vstack(h, { gap: "2", as: "section" }, [
					sectionHeading(h, { title, count: String(rows.length) }),
					table(h, { variant: "card", ariaLabel: title }, [tableBody(h, rows)]),
				]),
			]

/** A row's control sits above the row's link, so a click on it (even while disabled) never opens the source. */
const actionCell = (h: H, children: ReadonlyArray<Html>): Html =>
	tableCell(h, children, cn("text-right", ROW_LINK_LIFT))

/** A link to the tab that fixes the row, named for its source. */
const tabLink = (h: H, source: V2Source, tab: SourceTab, label: string): Html =>
	linkButton(
		h,
		{
			size: "xs",
			variant: "outline",
			href: sourceHref(source, tab),
			attributes: [h.AriaLabel(`${label}: ${source.name}`)],
		},
		[label],
	)

/**
 * Where a source that is not sending gets fixed: an integration's connection, a silent push
 * source's setup steps, or the rules (expiry, rate limit, signals) the gateway refuses it by.
 */
const fixLink = (h: H, model: Model, source: V2Source): ReadonlyArray<Html> => {
	if (integrationPlatformOf(source) !== null) return [tabLink(h, source, "connection", "Review connection")]
	if (source.health.status === "pending") return [tabLink(h, source, "setup", "Finish setup")]
	if (source.health.status === "stale") return [tabLink(h, source, "setup", "Check setup")]
	return canManage(model) ? [tabLink(h, source, "settings", "Review rules")] : []
}

const TEXT_TONE = { ok: "success", warn: "warning", crit: "error", neutral: "muted" } as const

/** "Failing · 1 of 3 unhealthy · Token revoked": the state, then its reason or when data last came. */
const statusLine = (h: H, source: V2Source, clock: Clock): RowLine => {
	const { status, problem, last_data_at: lastDataAt } = source.health
	const rollup = rollupLabel(source)
	const children = [
		typography(h, { tone: TEXT_TONE[statusTone(status)] }, [sourceStatusLabel(status)]),
		...(rollup === null ? [] : [" · ", rollup]),
		" · ",
		...(problem !== null
			? [problem]
			: lastDataAt === null
				? ["no data yet"]
				: [`${lastSeenWord(source)} `, relativeTime(h, { value: lastDataAt, ...clock })]),
	]
	return problem === null ? { children } : { children, title: problem }
}

const attentionRow = (h: H, model: Model, source: V2Source, clock: Clock): Html =>
	sourceRow(h, source, [
		sourceCell(h, source, statusLine(h, source, clock)),
		actionCell(h, fixLink(h, model, source)),
	])

const METER_CELL = "hidden md:table-cell"
const SIZE_CELL = "min-w-24"

const volumeCells = (
	h: H,
	source: V2Source,
	usage: UsageBySource,
	isUnavailable: boolean,
	largest: number,
): ReadonlyArray<Html> => {
	if (isUnavailable) return [tableCell(h, [], METER_CELL), numericTableCell(h, [emptyValue(h)], SIZE_CELL)]
	if (usage === null)
		return [
			tableCell(h, [], METER_CELL),
			numericTableCell(h, [skeleton(h, "ml-auto h-4 w-14")], SIZE_CELL),
		]
	const totals = usage.get(source.id) ?? NO_VOLUME
	// The per-signal counts are the cell's name and tooltip; the source page shows them in full.
	return [
		tableCell(
			h,
			[meter(h, { value: totals.bytes, max: largest, tone: "neutral", className: "w-48" })],
			METER_CELL,
		),
		numericTableCell(h, [volumeSize(totals)], `${SIZE_CELL} text-foreground`, [
			h.Title(signalCounts(totals)),
			h.AriaLabel(`${volumeSize(totals)} stored in the last 24 hours: ${signalCounts(totals)}`),
		]),
	]
}

const receivingRow = (
	h: H,
	source: V2Source,
	clock: Clock,
	usage: UsageBySource,
	isUnavailable: boolean,
	largest: number,
): Html =>
	sourceRow(h, source, [
		sourceCell(h, source, {
			children: [
				sourceKindLine(source),
				...(source.health.last_data_at === null
					? []
					: [" · ", relativeTime(h, { value: source.health.last_data_at, ...clock })]),
			],
		}),
		...volumeCells(h, source, usage, isUnavailable, largest),
		tableCell(h, [icon(h, "ChevronRightIcon", { size: 14, className: "text-muted-foreground" })]),
	])

const idleLine = (h: H, source: V2Source, clock: Clock): RowLine => {
	if (source.status === "paused") return { children: pausedLabel(h, source, clock.timeZone) }
	const { status } = source.health
	// The org's keys going unused is no fault; a refusal still says why.
	if (source.is_default && (status === "pending" || status === "stale"))
		return { children: ["Nothing sent with an org ingest key lately"] }
	return status === "pending"
		? {
				children: [
					sourceStatusLabel(status),
					" · created ",
					relativeTime(h, { value: source.created_at, ...clock }),
				],
			}
		: statusLine(h, source, clock)
}

/** Resume acts in place; a source still waiting for data links to what finishes its setup. */
const idleAction = (h: H, model: Model, source: V2Source): ReadonlyArray<Html> => {
	if (source.is_default) return []
	if (source.status !== "paused") return fixLink(h, model, source)
	return canManage(model)
		? [
				button(
					h,
					{
						size: "xs",
						variant: "outline",
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
			]
		: []
}

const idleRow = (h: H, model: Model, source: V2Source, clock: Clock): Html =>
	sourceRow(h, source, [
		sourceCell(h, source, idleLine(h, source, clock)),
		actionCell(h, idleAction(h, model, source)),
	])

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

const sourceGroups = (h: H, model: Model, rows: ReadonlyArray<V2Source>, clock: Clock): Html => {
	const usage = usageBySource(model)
	const isUnavailable = AsyncData.isFailure(model.usage.data)
	const hasAdded = !hasNoAddedSources(rows)
	const all = groupSources(rows, usage)
	const matching = (sources: ReadonlyArray<V2Source>) =>
		Arr.filter(sources, (source) => matchesSearch(source, model.search))
	// The receiving group is ranked by what it stored, so its first source sets the meters' scale.
	const largest = Option.match(Arr.head(all.receiving), {
		onNone: () => 0,
		onSome: (source) => usage?.get(source.id)?.bytes ?? 0,
	})
	const groups = [
		...group(
			h,
			"Needs attention",
			Arr.map(matching(all.attention), (source) => attentionRow(h, model, source, clock)),
		),
		...group(
			h,
			"Receiving",
			Arr.map(matching(all.receiving), (source) =>
				receivingRow(h, source, clock, usage, isUnavailable, largest),
			),
		),
		...group(
			h,
			"Not sending",
			Arr.map(matching(all.idle), (source) => idleRow(h, model, source, clock)),
		),
	]
	return vstack(h, { gap: "6" }, [
		// One source needs no search and has no total worth a line of its own.
		...(hasAdded ? [toolbar(h, model, orgTotal(h, rows, usage, isUnavailable))] : []),
		...groups,
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
