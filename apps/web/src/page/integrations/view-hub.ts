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
import { type CatalogEntry, HUB_CATALOG, INTEGRATION_CATEGORIES, type IntegrationId } from "./catalog"
import {
	type AvailableOverview,
	type ConnectedOverview,
	HEALTH_TONE,
	overviewOf,
	summaryOf,
	type UnavailableOverview,
	lastSyncText,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { STATUS_NAMES } from "./update-status"
import { entryPlate } from "./view-entry"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { Array as Arr, Order } from "effect"

// `IntegrationsSummary` and `IntegrationCatalog`.

type H = HtmlBuilder<Message>
type Select = (id: IntegrationId) => Message

export const integrationsSummary = (h: H, model: Model): Html | undefined => {
	const summary = summaryOf(model.statuses, model.nowMs)
	if (summary === null) return undefined
	return hstack(h, { gap: "2" }, [
		badge(h, { variant: "meta", pill: true, className: "gap-1.5 px-2.5 font-normal" }, [
			statusDot(h, { tone: "ok" }),
			`${summary.connected} connected`,
		]),
		...(summary.attention > 0
			? [
					badge(h, { variant: "warn", pill: true, className: "gap-1.5 px-2.5 font-normal" }, [
						statusDot(h, { tone: "warn" }),
						`${summary.attention} ${summary.attention === 1 ? "needs" : "need"} attention`,
					]),
				]
			: []),
	])
}

const connectedRow = (
	h: H,
	entry: CatalogEntry,
	overview: ConnectedOverview | UnavailableOverview,
	onSelect: Select,
	nowMs: number,
): Html => {
	const connected = overview.kind === "connected" ? overview : null
	return pressable(
		h,
		{
			onClick: onSelect(entry.id),
			className:
				"group flex w-full items-center gap-4 px-4 py-3 text-left outline-none hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
		},
		[
			entryPlate(h, entry, { plateClassName: "size-8 rounded-lg", size: 18 }),
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
					typography(h, { size: "sm", weight: "semibold", truncate: true }, [entry.name]),
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
				icon(h, "ChevronRightIcon", {
					size: 14,
					className: "text-foreground-subtle transition-colors group-hover:text-foreground",
				}),
			]),
		],
	)
}

export const newBadge = (h: H): Html => badge(h, { variant: "info", size: "sm" }, ["New"])

const availableCard = (h: H, entry: CatalogEntry, cta: AvailableOverview["cta"], onSelect: Select): Html =>
	cardButton(h, { onClick: onSelect(entry.id), className: "flex items-center gap-4 p-4" }, [
		entryPlate(h, entry, { plateClassName: "size-9 rounded-lg", size: 20 }),
		vstack(h, { gap: "0.5", shrink: true, grow: true, as: "span" }, [
			hstack(h, { gap: "2", shrink: true, as: "span" }, [
				typography(h, { size: "sm", weight: "semibold", truncate: true }, [entry.name]),
				...(entry.isNew === true ? [newBadge(h)] : []),
			]),
			h.span([h.Class("line-clamp-2 font-prose text-xs text-muted-foreground")], [entry.description]),
		]),
		h.span(
			[
				h.Class(
					cn(
						"shrink-0 rounded-md border border-input px-3 py-1.5 text-xs font-medium transition-colors group-hover:border-ring/60",
						cta === "Connect" ? "text-primary" : "text-foreground",
					),
				),
			],
			[cta, " →"],
		),
	])

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
	Arr.reduce<(typeof STATUS_NAMES)[number], LoadFailure | null>(STATUS_NAMES, null, (found, name) => {
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
				"Where Maple sends alerts and chat. Data sources like Cloudflare, Prometheus and GitHub are under ",
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

export const integrationCatalog = (h: H, model: Model, onSelect: Select): Html => {
	const rows = Arr.map(HUB_CATALOG, (entry) => ({
		entry,
		overview: overviewOf(model.statuses, model.nowMs, entry.id),
	}))
	const connected = Arr.flatMap(rows, ({ entry, overview }) =>
		overview !== null && (overview.kind === "connected" || overview.kind === "unavailable")
			? [{ entry, overview }]
			: [],
	)
	const available = Arr.flatMap(rows, ({ entry, overview }) =>
		overview !== null && overview.kind === "available" ? [{ entry, overview }] : [],
	)
	const loading = Arr.filter(rows, ({ overview }) => overview === null)
	const hasFailedRow = Arr.some(
		connected,
		({ overview }) => overview.kind === "unavailable" && overview.reason === "failed",
	)
	const statusFailure = hasFailedRow ? firstStatusFailure(model) : null
	const shelves = Arr.filter(
		Arr.map(INTEGRATION_CATEGORIES, (category) => ({
			...category,
			entries: Arr.sort(
				Arr.filter(available, ({ entry }) => entry.category === category.id),
				Order.flip(
					Order.mapInput(Order.Number, (item: (typeof available)[number]) =>
						Number(item.entry.isNew ?? false),
					),
				),
			),
		})),
		(shelf) => shelf.entries.length > 0,
	)
	return vstack(
		h,
		{
			gap: "6",
			className:
				"animate-in fade-in slide-in-from-bottom-1 [animation-duration:300ms] motion-reduce:animate-none",
		},
		[
			...(connected.length > 0 || loading.length > 0
				? [
						vstack(h, { gap: "2", as: "section" }, [
							// Unknown status must not read as healthy, so the header goes neutral.
							hstack(h, { gap: "3", justify: "between" }, [
								eyebrow(h, { variant: "label" }, [
									statusFailure === null ? "Connected" : "Destinations",
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
							panel(h, { className: "divide-y divide-border-subtle border-border-subtle" }, [
								...Arr.map(connected, ({ entry, overview }) =>
									connectedRow(h, entry, overview, onSelect, model.nowMs),
								),
								...Arr.map(loading, () => skeletonRow(h)),
							]),
						]),
					]
				: []),
			...Arr.map(shelves, (shelf) =>
				vstack(h, { gap: "2", as: "section" }, [
					eyebrow(h, { variant: "label" }, [shelf.label]),
					h.div(
						[h.Class("grid grid-cols-1 gap-3 lg:grid-cols-2")],
						Arr.map(shelf.entries, ({ entry, overview }) =>
							availableCard(h, entry, overview.cta, onSelect),
						),
					),
				]),
			),
		],
	)
}
