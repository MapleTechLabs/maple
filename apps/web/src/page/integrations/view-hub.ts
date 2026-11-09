import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { button } from "@maple/views/ui/button"
import { cardButton } from "@maple/views/ui/card-button"
import { errorState } from "@maple/views/ui/error-state"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { pageDescription, pageTitle } from "@maple/views/ui/page-layout"
import { pressable } from "@maple/views/ui/pressable"
import { panel } from "@maple/views/ui/panel"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { AppRoute, hrefOf } from "../../route"
import {
	CAPABILITY_LABEL,
	type CatalogEntry,
	type DataSourceKindEntry,
	DATA_SOURCE_KIND_ENTRY,
	type HubFilter,
	type IntegrationId,
} from "./catalog"
import {
	activeFilter,
	type ConnectedRow,
	filterCounts,
	hubRowsOf,
	matchesFilter,
	offeredFilters,
} from "./hub-rows"
import { integrationIconPlate } from "../infra-integrations/kit/integration-empty"
import { filterChip } from "@maple/views/ui/filter-chip"
import { type AvailableOverview, HEALTH_TONE, lastSyncText } from "./derive"
import { Message } from "./message"
import type { Model, Statuses } from "./model"
import { statusNamesOf } from "./update-status"
import { entryPlate } from "./view-entry"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// `IntegrationsSummary` and `IntegrationCatalog`.

type H = HtmlBuilder<Message>
type Select = (id: IntegrationId) => Message

export const integrationsSummary = (h: H, model: Model): Html | undefined => {
	const rows = hubRowsOf(model)
	const connected = Arr.filter(rows.connected, (row) => row.overview.kind === "connected").length
	if (rows.loading > 0 || connected === 0) return undefined
	return badge(h, { variant: "meta", pill: true, className: "gap-1.5 px-2.5 font-normal" }, [
		statusDot(h, { tone: "ok" }),
		`${connected} connected`,
	])
}

/** A data source kind's logo on the integration plate. */
const kindPlate = (
	h: H,
	entry: DataSourceKindEntry,
	options: Readonly<{ size: number; plateClassName: string }>,
) => integrationIconPlate(h, { icon: entry.icon, accent: entry.accent }, options)

const connectedRow = (h: H, row: ConnectedRow, onSelect: Select, nowMs: number): Html => {
	const overview = row.overview
	const plateOptions = { plateClassName: "size-8 rounded-lg", size: 18 }
	const plate =
		row._tag === "Integration"
			? entryPlate(h, row.entry, plateOptions)
			: kindPlate(h, DATA_SOURCE_KIND_ENTRY[row.source.kind], plateOptions)
	const name = row._tag === "Integration" ? row.entry.name : row.source.name
	const onClick =
		row._tag === "Integration"
			? onSelect(row.entry.id)
			: Message.ClickedDataSource({ source: row.source.id, connect: null })
	const connected = overview.kind === "connected" ? overview : null
	return pressable(
		h,
		{
			onClick,
			className:
				"group flex w-full items-center gap-4 px-4 py-3 text-left outline-none hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
		},
		[
			plate,
			vstack(
				h,
				{
					gap: "0.5",
					shrink: true,
					grow: true,
					as: "span",
					className: "sm:w-44 sm:flex-none 2xl:w-52",
				},
				[
					typography(h, { size: "sm", weight: "medium", truncate: true }, [name]),
					...(connected?.context
						? [typography(h, { size: "xs", tone: "muted", truncate: true }, [connected.context])]
						: []),
				],
			),
			// With no stat beside it the status takes the free width, so long labels read in full.
			h.span(
				[
					h.Class(
						cn(
							hstackClass({ gap: "2" }),
							connected?.stat ? "w-36 shrink-0" : "min-w-36 flex-1 justify-end",
						),
					),
				],
				// A failed read says so once above the list; the row keeps a muted "Unknown".
				connected === null && overview.kind === "unavailable" && overview.reason === "failed"
					? [
							statusDot(h, { tone: "neutral" }),
							typography(h, { size: "xs", tone: "muted" }, ["Unknown"]),
						]
					: [
							statusDot(h, {
								tone: connected !== null ? HEALTH_TONE[connected.health] : "neutral",
							}),
							typography(h, { size: "xs", truncate: true }, [
								connected?.stateLabel ?? "Not configured",
							]),
						],
			),
			...(connected?.stat
				? [
						h.span(
							[h.Class("hidden min-w-0 flex-1 truncate text-sm text-foreground-soft md:block")],
							[connected.stat],
						),
					]
				: []),
			hstack(h, { gap: "3", align: "center", as: "span", className: "ml-auto shrink-0" }, [
				...(connected !== null && connected.lastSync !== null
					? [
							h.span(
								[h.Class("hidden w-28 text-right text-xs text-muted-foreground 2xl:block")],
								[lastSyncText(connected.lastSync, nowMs)],
							),
						]
					: []),
				...(connected?.issue
					? [
							badge(
								h,
								{
									variant: connected.health === "pending" ? "outline" : "warn",
									size: "sm",
									className: "hidden sm:inline-flex",
								},
								[connected.issue],
							),
						]
					: []),
				badge(h, { variant: "meta", size: "sm", className: "hidden sm:inline-flex" }, [
					CAPABILITY_LABEL[row.capability].chip,
				]),
				icon(h, "ChevronRightIcon", {
					size: 14,
					className: "text-foreground-subtle group-hover:text-foreground",
				}),
			]),
		],
	)
}

export const newBadge = (h: H): Html => badge(h, { variant: "info", size: "sm" }, ["New"])

const availableCard = (
	h: H,
	options: Readonly<{
		plate: Html
		name: string
		description: string
		isNew: boolean
		cta: AvailableOverview["cta"]
		onClick: Message
	}>,
): Html =>
	cardButton(h, { onClick: options.onClick, className: "flex items-center gap-4 p-4" }, [
		options.plate,
		vstack(h, { gap: "0.5", shrink: true, grow: true, as: "span" }, [
			hstack(h, { gap: "2", shrink: true, as: "span" }, [
				typography(h, { size: "sm", weight: "medium", truncate: true }, [options.name]),
				...(options.isNew ? [newBadge(h)] : []),
			]),
			h.span([h.Class("line-clamp-2 font-prose text-xs text-muted-foreground")], [options.description]),
		]),
		h.span(
			[
				h.Class(
					cn(
						"shrink-0 rounded-md border border-input px-3 py-1.5 text-xs font-medium group-hover:border-border-strong",
						options.cta === "Connect" ? "text-primary" : "text-foreground",
					),
				),
			],
			[options.cta, " →"],
		),
	])

const entryCard = (h: H, entry: CatalogEntry, cta: AvailableOverview["cta"], onSelect: Select): Html =>
	availableCard(h, {
		plate: entryPlate(h, entry, { plateClassName: "size-9 rounded-lg", size: 20 }),
		name: entry.name,
		description: entry.description,
		isNew: entry.isNew === true,
		cta,
		onClick: onSelect(entry.id),
	})

const kindCard = (h: H, entry: DataSourceKindEntry): Html =>
	availableCard(h, {
		plate: kindPlate(h, entry, { plateClassName: "size-9 rounded-lg", size: 20 }),
		name: entry.name,
		description: entry.description,
		isNew: true,
		cta: "Connect",
		onClick: Message.ClickedDataSource({ source: null, connect: entry.kind }),
	})

const skeletonRow = (h: H): Html =>
	hstack(h, { gap: "4", align: "center", className: "w-full px-4 py-3" }, [
		skeleton(h, "size-8 shrink-0 rounded-lg"),
		vstack(h, { gap: "1.5", as: "span", className: "w-52 shrink-0" }, [
			skeleton(h, "h-3.5 w-24"),
			skeleton(h, "h-3 w-32"),
		]),
		skeleton(h, "h-3 w-20"),
	])

/** The first failed status read, for the one error line above the connected list. */
const firstStatusFailure = (model: Model): LoadFailure | null =>
	Arr.reduce<keyof Statuses, LoadFailure | null>(statusNamesOf(model), null, (found, name) => {
		const { data } = model.statuses[name]
		return found ?? (data._tag === "Failure" || data._tag === "Stale" ? data.error : null)
	})

/** The hub's title and its one-line description, tight under the `<h1>` like every page header. */
export const hubTitle = (h: H): Html =>
	vstack(h, { gap: "1" }, [
		pageTitle(h, { className: "leading-8" }, ["Integrations"]),
		pageDescription(
			h,
			[
				"Systems Maple collects telemetry from, queries in place, and sends alerts to. Volume and caps per source are under ",
				h.a(
					[
						h.Href(hrefOf(AppRoute.Sources())),
						h.Class(
							typographyClass({
								tone: "foreground",
								className: "underline underline-offset-2",
							}),
						),
					],
					["Sources"],
				),
				".",
			],
			"text-sm",
		),
	])

const FILTER_LABEL = {
	all: "All",
	telemetry: CAPABILITY_LABEL.telemetry.filter,
	query: CAPABILITY_LABEL.query.filter,
	alerts: CAPABILITY_LABEL.alerts.filter,
	analytics: CAPABILITY_LABEL.analytics.filter,
	attention: "Needs attention",
} as const satisfies Record<HubFilter, string>

/** All, one chip per capability, and "Needs attention" while something does. */
const filterBar = (h: H, model: Model, rows: ReadonlyArray<ConnectedRow>): Html => {
	const counts = filterCounts(rows)
	const active = activeFilter(model, rows)
	const filters = offeredFilters(model, rows)
	return hstack(
		h,
		{ gap: "1.5", wrap: true, attributes: [h.Role("group"), h.AriaLabel("Filter integrations")] },
		Arr.map(filters, (filter) =>
			filterChip(
				h,
				{
					isPressed: active === filter,
					onClick: Message.SelectedFilter({ filter: active === filter ? "all" : filter }),
					size: "xs",
					count: String(counts[filter]),
					tone: filter === "attention" ? "warn" : "neutral",
					hasDot: filter === "attention",
				},
				[FILTER_LABEL[filter]],
			),
		),
	)
}

export const integrationCatalog = (h: H, model: Model, onSelect: Select): Html => {
	const { connected, loading, shelves, isDataSourcesFailed } = hubRowsOf(model)
	const filter = activeFilter(model, connected)
	const shown = Arr.filter(connected, (row) => matchesFilter(filter, row))
	const shownShelves = Arr.filter(shelves, (shelf) => filter === "all" || filter === shelf.capability)
	const hasFailedRow = Arr.some(
		connected,
		(row) => row.overview.kind === "unavailable" && row.overview.reason === "failed",
	)
	const statusFailure = hasFailedRow || isDataSourcesFailed ? firstStatusFailure(model) : null
	return vstack(
		h,
		{
			gap: "6",
			className:
				"animate-in fade-in slide-in-from-bottom-1 [animation-duration:300ms] motion-reduce:animate-none",
		},
		[
			...(connected.length > 0 || loading > 0 || statusFailure !== null
				? [
						vstack(h, { gap: "3", as: "section" }, [
							...(connected.length > 0 ? [filterBar(h, model, connected)] : []),
							// Unknown status must not read as healthy, so the header goes neutral.
							hstack(h, { gap: "3", justify: "between" }, [
								eyebrow(h, { variant: "label" }, [
									statusFailure === null ? "Connected" : "Integrations",
								]),
								...(statusFailure === null
									? []
									: [
											hstack(h, { gap: "2" }, [
												errorState(h, {
													failure: statusFailure,
													title: "Couldn't check integration status",
													variant: "quiet",
													hidesRetryButton: true,
													onRetry: Message.ClickedRetryFailedStatuses(),
												}),
												button(
													h,
													{
														variant: "outline",
														size: "xs",
														attributes: [
															h.OnClick(Message.ClickedRetryFailedStatuses()),
														],
													},
													["Try again"],
												),
											]),
										]),
							]),
							shown.length === 0 && loading === 0
								? typography(h, { size: "sm", tone: "muted" }, [
										filter === "attention"
											? "Nothing needs attention."
											: "Nothing connected here yet.",
									])
								: panel(
										h,
										{ className: "divide-y divide-border-subtle border-border-subtle" },
										[
											...Arr.map(shown, (row) =>
												connectedRow(h, row, onSelect, model.nowMs),
											),
											// `makeBy` makes at least one, so no reads in flight must draw none.
											...(loading > 0 ? Arr.makeBy(loading, () => skeletonRow(h)) : []),
										],
									),
						]),
					]
				: []),
			...Arr.map(shownShelves, (shelf) =>
				vstack(h, { gap: "2", as: "section" }, [
					eyebrow(h, { variant: "label" }, [shelf.label]),
					h.div(
						[h.Class("grid grid-cols-1 gap-3 lg:grid-cols-2")],
						shelf._tag === "DataSources"
							? Arr.map(shelf.kinds, (kind) => kindCard(h, kind))
							: Arr.map(shelf.entries, ({ entry, cta }) => entryCard(h, entry, cta, onSelect)),
					),
				]),
			),
		],
	)
}
