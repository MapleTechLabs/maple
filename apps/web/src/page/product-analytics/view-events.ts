import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { compactSearchInput } from "@maple/views/ui/compact-search-input"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { meter } from "@maple/views/ui/meter"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { hstack, vstack } from "@maple/views/ui/stack"
import {
	numericTableCell,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { tableSkeleton } from "@maple/views/ui/table-skeleton"
import { typography } from "@maple/views/ui/typography"
import { docsLink } from "../kit/signal-empty-state"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"
import { Message } from "./message"
import { type EventKindFilter, type EventRow, isCustomEvent, type Model } from "./model"
import { EVENTS_LIMIT } from "./requests"
import { emptyPanel } from "./view-parts"

// The Events tab: every event name in the window, and the way into a funnel or paths from one.

type H = HtmlBuilder<Message>

const kindOf = (row: EventRow) =>
	row.kind === "navigation"
		? { label: "Page view", variant: "info" as const }
		: row.kind === "screen"
			? { label: "Screen", variant: "done" as const }
			: { label: "Custom", variant: "live" as const }

const KIND_FILTERS: ReadonlyArray<{ value: EventKindFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "custom", label: "Custom" },
	{ value: "navigation", label: "Page views" },
	{ value: "screen", label: "Screens" },
]

const sum = (rows: ReadonlyArray<EventRow>): number => rows.reduce((total, row) => total + row.count, 0)

/** `+12% vs previous period`, or nothing when the previous window is empty or still loading. */
const deltaOf = (model: Model, current: number): string | undefined => {
	const previous = Option.getOrUndefined(AsyncData.getData(model.previousEvents.data))
	const before = previous === undefined ? 0 : sum(previous)
	if (before === 0) return undefined
	const change = Math.round(((current - before) / before) * 100)
	return `${change >= 0 ? "+" : ""}${change}% vs previous period`
}

const kindSummary = (rows: ReadonlyArray<EventRow>): string => {
	const pages = rows.filter((row) => row.kind === "navigation").length
	const screens = rows.filter((row) => row.kind === "screen").length
	const custom = rows.length - pages - screens
	return [
		`${custom} custom`,
		...(pages > 0 ? [`${pages} ${pluralize(pages, "page view")}`] : []),
		...(screens > 0 ? [`${screens} ${pluralize(screens, "screen")}`] : []),
	].join(" · ")
}

const stats = (h: H, model: Model, rows: ReadonlyArray<EventRow>, isCapped: boolean): Html => {
	const total = sum(rows)
	const top = rows
		.filter(isCustomEvent)
		.reduce<EventRow | undefined>(
			(best, row) => (best === undefined || row.persons > best.persons ? row : best),
			undefined,
		)
	return statRail(h, { columns: 3 }, [
		statRailItem(h, {
			eyebrow: "Events",
			value: formatNumber(total),
			delta: isCapped ? undefined : deltaOf(model, total),
			subline: isCapped ? `across the top ${EVENTS_LIMIT} names` : undefined,
		}),
		statRailItem(h, {
			eyebrow: "Event names",
			value: isCapped ? `${EVENTS_LIMIT}+` : formatNumber(rows.length),
			subline: kindSummary(rows),
		}),
		statRailItem(h, {
			eyebrow: "Top custom event",
			value: top?.eventName ?? "–",
			valueClassName: "truncate font-mono text-lg",
			subline:
				top === undefined
					? undefined
					: `${formatNumber(top.persons)} ${pluralize(top.persons, "person", "people")}`,
		}),
	])
}

const visibleRows = (model: Model, rows: ReadonlyArray<EventRow>): ReadonlyArray<EventRow> => {
	const query = model.eventsQuery.trim().toLowerCase()
	return rows
		.filter((row) =>
			model.eventsKind === "all"
				? true
				: model.eventsKind === "custom"
					? isCustomEvent(row)
					: row.kind === model.eventsKind,
		)
		.filter((row) => query === "" || row.eventName.toLowerCase().includes(query))
		.toSorted((a, b) => b.persons - a.persons || b.count - a.count)
}

const rowActions = (h: H, row: EventRow): Html =>
	hstack(h, { gap: "1", justify: "end" }, [
		button(
			h,
			{
				variant: "ghost",
				size: "xs",
				attributes: [
					h.AriaLabel(`Build a funnel from ${row.eventName}`),
					h.OnClick(
						Message.ClickedStartFunnel({ step: { kind: "event", eventName: row.eventName } }),
					),
				],
			},
			[icon(h, "FilterIcon"), "Funnel"],
		),
		button(
			h,
			{
				variant: "ghost",
				size: "xs",
				attributes: [
					h.AriaLabel(`Paths from ${row.eventName}`),
					h.OnClick(
						Message.ClickedStartPaths({ anchor: { kind: "event", eventName: row.eventName } }),
					),
				],
			},
			[icon(h, "BranchForkIcon"), "Paths"],
		),
	])

const eventsTable = (h: H, model: Model, rows: ReadonlyArray<EventRow>): Html => {
	const shown = visibleRows(model, rows)
	const maxPersons = Math.max(1, ...rows.map((row) => row.persons))
	if (shown.length === 0)
		return filteredEmpty(h, { noun: "events", onClear: Message.ClickedClearEventsFilters() })
	return table(h, { variant: "bare", size: "sm", ariaLabel: "Product events" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Event"]),
				tableHead(h, ["Kind"]),
				tableHead(h, ["Events"], "text-right"),
				tableHead(h, ["Sessions"], "text-right"),
				tableHead(h, ["People"], "text-right"),
				tableHead(h, [typography(h, { className: "sr-only" }, ["Actions"])]),
			]),
		]),
		tableBody(
			h,
			shown.map((row) => {
				const kind = kindOf(row)
				return tableRow(
					h,
					[
						tableCell(
							h,
							[typography(h, { size: "xs", mono: true, truncate: true }, [row.eventName])],
							"max-w-80",
						),
						tableCell(h, [badge(h, { variant: kind.variant, size: "sm" }, [kind.label])]),
						numericTableCell(h, [formatNumber(row.count)]),
						numericTableCell(h, [formatNumber(row.sessions)]),
						numericTableCell(h, [
							hstack(h, { gap: "2.5", justify: "end" }, [
								formatNumber(row.persons),
								meter(h, {
									value: row.persons,
									max: maxPersons,
									minVisible: 0.01,
									className: "w-24",
								}),
							]),
						]),
						tableCell(h, [rowActions(h, row)], "w-px"),
					],
					undefined,
					[h.Key(`${row.kind}:${row.eventName}`)],
				)
			}),
		),
	])
}

const sendYourOwn = (h: H): Html =>
	hstack(h, { gap: "2", wrap: true, className: "border-t px-4 py-2.5" }, [
		typography(h, { size: "xs", tone: "muted", className: "flex-1" }, [
			'Send your own with track("name", props) in the browser, POST /v1/events from a server, or a span attribute.',
		]),
		docsLink(h, "productEventsApi", "Event docs"),
	])

export const eventsTab = (h: H, model: Model): Html =>
	AsyncData.matchData(model.events.data, {
		onEmpty: () =>
			vstack(h, { gap: "4" }, [
				statRailLoading(h, 3, 3),
				panel(h, {}, [tableSkeleton(h, { columns: 6, rows: 8 })]),
			]),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load product events",
				onRetry: Message.ClickedRetry({ slot: "events" }),
			}),
		onData: (answer) => {
			// The read asks for one name past EVENTS_LIMIT: if it came back, totals and the trend
			// would undercount, so the page says so instead.
			const isCapped = answer.length > EVENTS_LIMIT
			const rows = answer.slice(0, EVENTS_LIMIT)
			return rows.length === 0
				? emptyPanel(h, "No product events in this window", [
						"Page views arrive with web analytics. Custom events come from track() in the browser SDK, POST /v1/events from a backend, or an annotated span.",
						hstack(h, { justify: "center", className: "mt-3" }, [
							docsLink(h, "productEventsApi"),
						]),
					])
				: vstack(h, { gap: "4" }, [
						stats(h, model, rows, isCapped),
						panel(h, {}, [
							panelHeader(h, {
								title: "All events",
								action: hstack(h, { gap: "2", wrap: true }, [
									segmentedSelect(h, {
										options: KIND_FILTERS,
										value: model.eventsKind,
										onChange: (kind) => Message.PickedEventsKind({ kind }),
										size: "xs",
										ariaLabel: "Event kind",
									}),
									compactSearchInput(h, {
										value: model.eventsQuery,
										placeholder: "Filter events…",
										ariaLabel: "Filter events",
										onInput: (value) => Message.ChangedEventsQuery({ value }),
										onClear: Message.ChangedEventsQuery({ value: "" }),
										className: "w-full sm:w-48",
									}),
								]),
							}),
							eventsTable(h, model, rows),
							sendYourOwn(h),
						]),
					])
		},
	})
