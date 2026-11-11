import type { CostSourceStatus, CostSourceSummary } from "@maple/domain/http"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { PROVIDERS, providerBrand } from "../kit/providers"
import { relativeTime } from "../kit/relative-time"
import { formatDay, requestsCost } from "./derive"
import type { Message } from "./message"

type H = HtmlBuilder<Message>

const STATUS = {
	ok: { label: "Synced", variant: "ok" },
	syncing: { label: "Syncing history", variant: "info" },
	pending: { label: "Waiting for first sync", variant: "muted" },
	paused: { label: "Paused", variant: "muted" },
	error: { label: "Sync failing", variant: "crit" },
} as const satisfies Record<
	CostSourceStatus,
	Readonly<{ label: string; variant: "ok" | "info" | "muted" | "crit" }>
>

/** Where the org's connections are listed and changed. */
export const SOURCES_HREF = hrefOf(AppRoute.Sources())

/** How far the sync is: the newest day, how far back history goes, and when it last ran. */
const facts = (
	h: H,
	source: CostSourceSummary,
	nowMs: number,
	timeZone: string,
): ReadonlyArray<Html | string> => [
	...(source.watermarkDate === null ? [] : [`Synced through ${formatDay(source.watermarkDate)}`]),
	...(source.historyComplete
		? ["History complete"]
		: source.backfillDate === null
			? []
			: [`History back to ${formatDay(source.backfillDate, true)}`]),
	...(source.lastSyncedAt === null
		? []
		: [
				hstack(h, { gap: "1", inline: true, as: "span" }, [
					"Last sync",
					relativeTime(h, { value: source.lastSyncedAt, nowMs, timeZone }),
				]),
			]),
	`${formatNumber(source.requestsThisMonth)} provider ${pluralize(source.requestsThisMonth, "request")} this month (${requestsCost(source.requestsThisMonth)})`,
]

/** What the status alone does not say: why a sync fails, and what pausing keeps. */
const note = (h: H, source: CostSourceSummary): ReadonlyArray<Html> =>
	source.status === "error" && source.lastError !== null
		? [typography(h, { size: "xs", tone: "error", as: "p" }, [source.lastError])]
		: source.status === "paused"
			? [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"This connection no longer supplies cost. Its history stays.",
					]),
				]
			: []

const sourceRow = (h: H, source: CostSourceSummary, nowMs: number, timeZone: string): Html => {
	const brand = providerBrand(source.provider)
	const status = STATUS[source.status]
	return hstack(
		h,
		{
			as: "li",
			gap: "3",
			align: "start",
			className: stripClass("row", "py-3"),
			attributes: [h.Key(source.id)],
		},
		[
			icon(h, brand.icon, { size: 18, className: cn("mt-0.5 shrink-0", brand.iconClassName) }),
			vstack(h, { gap: "1", grow: true, shrink: true }, [
				hstack(h, { gap: "2", wrap: true }, [
					typography(h, { size: "sm", weight: "medium" }, [PROVIDERS[source.provider].name]),
					typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
						source.accountId,
					]),
					badge(h, { variant: status.variant, size: "sm" }, [status.label]),
				]),
				hstack(
					h,
					{ gap: "4", wrap: true, className: "gap-y-0.5" },
					Arr.map(facts(h, source, nowMs, timeZone), (fact) =>
						typography(h, { size: "xs", tone: "muted" }, [fact]),
					),
				),
				...note(h, source),
			]),
		],
	)
}

/** Each connection that supplies cost, and how far its sync is. */
export const sourcesSection = (
	h: H,
	sources: ReadonlyArray<CostSourceSummary>,
	nowMs: number,
	timeZone: string,
): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Sources",
			action: typography(h, { size: "xs" }, [
				textLink(h, { href: SOURCES_HREF, tone: "muted" }, ["Manage sources"]),
			]),
		}),
		vstack(
			h,
			{ as: "ul", gap: "0" },
			Arr.map(sources, (source) => sourceRow(h, source, nowMs, timeZone)),
		),
	])
