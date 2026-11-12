import type { CostSourceStatus, CostSourceSummary } from "@maple/domain/http"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { relativeTime } from "../kit/relative-time"
import { formatDay, requestsCost } from "./derive"
import { Message } from "./message"
import { COST_PROVIDERS } from "./providers"
import { AWS_INTEGRATION_HREF } from "./view-add-source"

type H = HtmlBuilder<Message>

const STATUS = {
	ok: { label: "Synced", variant: "ok" },
	syncing: { label: "Syncing history", variant: "info" },
	pending: { label: "Waiting for first sync", variant: "muted" },
	paused: { label: "Paused", variant: "muted" },
	held: { label: "On hold", variant: "muted" },
	error: { label: "Sync failing", variant: "crit" },
} as const satisfies Record<
	CostSourceStatus,
	Readonly<{ label: string; variant: "ok" | "info" | "muted" | "crit" }>
>

/** What a row offers: an AWS source is its connection's, an OpenRouter one is its key. */
const actions = (h: H, source: CostSourceSummary, isBusy: boolean): ReadonlyArray<Html> =>
	source.provider === "openrouter"
		? [
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						isDisabled: isBusy,
						attributes: [h.OnClick(Message.ClickedReplaceKey())],
					},
					["Replace key"],
				),
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						isDisabled: isBusy,
						attributes: [h.OnClick(Message.ClickedRemoveSource())],
					},
					["Remove"],
				),
			]
		: [linkButton(h, { variant: "ghost", size: "sm", href: AWS_INTEGRATION_HREF }, ["Manage connection"])]

/** What the provider billed the account for Maple's requests this month; nothing where requests are free. */
const requestsFact = (source: CostSourceSummary): ReadonlyArray<string> => {
	const cost = requestsCost(source.provider, source.requestsThisMonth)
	return cost === null
		? []
		: [
				`${formatNumber(source.requestsThisMonth)} provider ${pluralize(source.requestsThisMonth, "request")} this month (${cost})`,
			]
}

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
	...requestsFact(source),
]

/** What the status alone does not say: why a sync fails or waits, and what pausing keeps. */
const note = (h: H, source: CostSourceSummary): ReadonlyArray<Html> =>
	source.status === "error" && source.lastError !== null
		? [typography(h, { size: "xs", tone: "error", as: "p" }, [source.lastError])]
		: source.status === "paused"
			? [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"This connection no longer supplies cost. Its history stays.",
					]),
				]
			: // Held is not a failure: the reason reads as a note, not as an error.
				source.status === "held" && source.lastError !== null
				? [typography(h, { size: "xs", tone: "muted", as: "p" }, [source.lastError])]
				: []

const sourceRow = (
	h: H,
	source: CostSourceSummary,
	nowMs: number,
	timeZone: string,
	isBusy: boolean,
): Html => {
	const provider = COST_PROVIDERS[source.provider]
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
			icon(h, provider.icon, { size: 18, className: cn("mt-0.5 shrink-0", provider.iconClassName) }),
			vstack(h, { gap: "1", grow: true, shrink: true }, [
				// The actions share the title's line, so the facts below keep the row's width on a phone.
				hstack(h, { gap: "2", wrap: true, justify: "between", className: "gap-y-1" }, [
					hstack(h, { gap: "2", wrap: true }, [
						typography(h, { size: "sm", weight: "medium" }, [provider.name]),
						typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
							source.accountId,
						]),
						badge(h, { variant: status.variant, size: "sm" }, [status.label]),
					]),
					hstack(h, { gap: "1", className: "-my-1 shrink-0" }, actions(h, source, isBusy)),
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
	/** A key write is in flight: the row actions wait for it. */
	isBusy: boolean,
): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Sources",
			action: button(
				h,
				{
					variant: "outline",
					size: "sm",
					isDisabled: isBusy,
					attributes: [h.OnClick(Message.ClickedAddSource())],
				},
				["Add source"],
			),
		}),
		vstack(
			h,
			{ as: "ul", gap: "0" },
			Arr.map(sources, (source) => sourceRow(h, source, nowMs, timeZone, isBusy)),
		),
	])
