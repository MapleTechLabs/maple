import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../ui/display"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { panel } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { AppRoute, hrefOf } from "../../route"
import { type CatalogEntry, HUB_CATALOG, INTEGRATION_CATEGORIES, type IntegrationId } from "./catalog"
import {
	type AvailableOverview,
	type ConnectedOverview,
	HEALTH_TONE,
	overviewOf,
	summaryOf,
	type UnavailableOverview,
} from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"
import { entryPlate } from "./view-entry"

// `IntegrationsSummary` and `IntegrationCatalog`.

type H = HtmlBuilder<Message>
type Select = (id: IntegrationId) => Message

export const integrationsSummary = (h: H, model: Model): Html | undefined => {
	const summary = summaryOf(model.statuses, model.nowMs)
	if (summary === null) return undefined
	return h.div(
		[h.Class("flex items-center gap-2")],
		[
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
		],
	)
}

const connectedRow = (
	h: H,
	entry: CatalogEntry,
	overview: ConnectedOverview | UnavailableOverview,
	onSelect: Select,
): Html => {
	const connected = overview.kind === "connected" ? overview : null
	return h.button(
		[
			h.Type("button"),
			h.OnClick(onSelect(entry.id)),
			h.Class(
				"group flex w-full items-center gap-4 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
			),
		],
		[
			entryPlate(h, entry, { plateClassName: "size-8 rounded-lg", size: 18 }),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5 sm:w-44 sm:flex-none 2xl:w-52")],
				[
					h.span([h.Class("truncate text-sm font-semibold")], [entry.name]),
					...(connected?.context
						? [h.span([h.Class("truncate text-xs text-muted-foreground")], [connected.context])]
						: []),
				],
			),
			h.span(
				[h.Class("flex w-36 shrink-0 items-center gap-2")],
				[
					statusDot(h, { tone: HEALTH_TONE[connected?.health ?? "unavailable"] }),
					h.span([h.Class("truncate text-xs")], [connected?.stateLabel ?? "Status unavailable"]),
				],
			),
			...(connected?.stat
				? [
						h.span(
							[h.Class("hidden min-w-0 flex-1 truncate text-sm text-foreground/90 md:block")],
							[connected.stat],
						),
					]
				: []),
			h.span(
				[h.Class("ml-auto flex shrink-0 items-center gap-3")],
				[
					...(connected?.lastSyncLabel
						? [
								h.span(
									[
										h.Class(
											"hidden w-28 text-right text-xs text-muted-foreground 2xl:block",
										),
									],
									[connected.lastSyncLabel],
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
						className: "text-muted-foreground/70 transition-colors group-hover:text-foreground",
					}),
				],
			),
		],
	)
}

export const newBadge = (h: H): Html => badge(h, { variant: "info", size: "sm" }, ["New"])

const availableCard = (h: H, entry: CatalogEntry, cta: AvailableOverview["cta"], onSelect: Select): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(onSelect(entry.id)),
			h.Class(
				"group flex items-center gap-4 rounded-lg border border-border/60 bg-card p-4 text-left outline-none transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
			),
		],
		[
			entryPlate(h, entry, { plateClassName: "size-9 rounded-lg", size: 20 }),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[
					h.span(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							h.span([h.Class("truncate text-sm font-semibold")], [entry.name]),
							...(entry.isNew === true ? [newBadge(h)] : []),
						],
					),
					h.span([h.Class("line-clamp-2 text-xs text-muted-foreground")], [entry.description]),
				],
			),
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
		],
	)

const skeletonRow = (h: H): Html =>
	h.div(
		[h.Class("flex w-full items-center gap-4 px-4 py-3")],
		[
			skeleton(h, "size-8 shrink-0 rounded-lg"),
			h.span(
				[h.Class("flex w-52 shrink-0 flex-col gap-1.5")],
				[skeleton(h, "h-3.5 w-24"), skeleton(h, "h-3 w-32")],
			),
			skeleton(h, "h-3 w-20"),
		],
	)

export const integrationCatalog = (h: H, model: Model, onSelect: Select): Html => {
	const rows = HUB_CATALOG.map((entry) => ({
		entry,
		overview: overviewOf(model.statuses, model.nowMs, entry.id),
	}))
	const connected = rows.flatMap(({ entry, overview }) =>
		overview !== null && (overview.kind === "connected" || overview.kind === "unavailable")
			? [{ entry, overview }]
			: [],
	)
	const available = rows.flatMap(({ entry, overview }) =>
		overview !== null && overview.kind === "available" ? [{ entry, overview }] : [],
	)
	const loading = rows.filter(({ overview }) => overview === null)
	const shelves = INTEGRATION_CATEGORIES.map((category) => ({
		...category,
		entries: available
			.filter(({ entry }) => entry.category === category.id)
			.toSorted((a, b) => Number(b.entry.isNew ?? false) - Number(a.entry.isNew ?? false)),
	})).filter((shelf) => shelf.entries.length > 0)
	return h.div(
		[
			h.Class(
				"flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-1 [animation-duration:300ms] motion-reduce:animate-none",
			),
		],
		[
			h.p(
				[h.Class("font-prose text-muted-foreground text-sm")],
				[
					"Cloudflare, Prometheus, GitHub and the other integrations that bring data in are under ",
					h.a(
						[
							h.Href(hrefOf(AppRoute.Sources())),
							h.Class("text-foreground underline underline-offset-2"),
						],
						["Sources"],
					),
					".",
				],
			),
			...(connected.length > 0 || loading.length > 0
				? [
						h.section(
							[h.Class("flex flex-col gap-2")],
							[
								eyebrow(h, { variant: "label" }, ["Connected"]),
								panel(h, { className: "divide-y divide-border/60 border-border/60" }, [
									...connected.map(({ entry, overview }) =>
										connectedRow(h, entry, overview, onSelect),
									),
									...loading.map(() => skeletonRow(h)),
								]),
							],
						),
					]
				: []),
			...shelves.map((shelf) =>
				h.section(
					[h.Class("flex flex-col gap-2")],
					[
						eyebrow(h, { variant: "label" }, [shelf.label]),
						h.div(
							[h.Class("grid grid-cols-1 gap-3 lg:grid-cols-2")],
							shelf.entries.map(({ entry, overview }) =>
								availableCard(h, entry, overview.cta, onSelect),
							),
						),
					],
				),
			),
		],
	)
}
