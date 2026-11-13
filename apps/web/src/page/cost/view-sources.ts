import type { CostSourceStatus, CostSourceSummary } from "@maple/domain/http"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { relativeTime } from "../kit/relative-time"
import { CREDENTIAL_SOURCES } from "./credential-sources"
import { formatDay, requestsCost } from "./derive"
import { Message } from "./message"
import { COST_PROVIDERS, type CostProviderEntry, credentialProviderOf } from "./providers"
import { PLANETSCALE_INTEGRATION_HREF } from "./view-add-planetscale"
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

/** A row's action. Its accessible name says whose source it acts on: two rows can offer the same one. */
const rowButton = (h: H, label: string, name: string, onClick: Message, isBusy: boolean): Html =>
	button(
		h,
		{
			variant: "ghost",
			size: "sm",
			isDisabled: isBusy,
			attributes: [h.AriaLabel(name), h.OnClick(onClick)],
		},
		[label],
	)

/** Where the source's connection is changed: an account's Cost module, an organization's authorization. */
const connectionLink = (h: H, name: string, href: string): Html =>
	linkButton(
		h,
		{ variant: "ghost", size: "sm", href, attributes: [h.AriaLabel(`Manage ${name} connection`)] },
		["Manage connection"],
	)

/**
 * What a row offers: a connection's source is managed there, a pasted credential's is replaced or
 * removed here, a GitHub one only leaves, since it reads through the GitHub connection, and a
 * PlanetScale one leaves here while its connection, which is managed there, stays.
 * `isOnlyOfProvider`: false when the org has several sources of the provider, whose actions then
 * name the account too.
 */
const actions = (
	h: H,
	source: CostSourceSummary,
	isBusy: boolean,
	isOnlyOfProvider: boolean,
): ReadonlyArray<Html> => {
	const providerName = COST_PROVIDERS[source.provider].name
	const name = isOnlyOfProvider ? providerName : `${providerName} ${source.accountId}`
	const remove = rowButton(
		h,
		"Remove",
		`Remove ${name} source`,
		Message.ClickedRemoveSource({ sourceId: source.id }),
		isBusy,
	)
	const provider = credentialProviderOf(source.provider)
	if (provider !== null) {
		const { label } = CREDENTIAL_SOURCES[provider].replace
		return [
			rowButton(
				h,
				label,
				// "Replace key" as "Replace OpenRouter key".
				Str.replace("Replace", `Replace ${name}`)(label),
				Message.ClickedReplaceCredential({ provider }),
				isBusy,
			),
			remove,
		]
	}
	if (source.provider === "github") return [remove]
	if (source.provider === "planetscale") {
		return [connectionLink(h, name, PLANETSCALE_INTEGRATION_HREF), remove]
	}
	return [connectionLink(h, name, AWS_INTEGRATION_HREF)]
}

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
	options: Readonly<{ isBusy: boolean; canManage: boolean; isOnlyOfProvider: boolean }>,
): Html => {
	const provider: CostProviderEntry = COST_PROVIDERS[source.provider]
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
					...(options.canManage
						? [
								hstack(
									h,
									{ gap: "1", className: "-my-1 shrink-0" },
									actions(h, source, options.isBusy, options.isOnlyOfProvider),
								),
							]
						: []),
				]),
				hstack(
					h,
					{ gap: "4", wrap: true, className: "gap-y-0.5" },
					Arr.map(facts(h, source, nowMs, timeZone), (fact) =>
						typography(h, { size: "xs", tone: "muted" }, [fact]),
					),
				),
				// What the provider's source says about its own figures, whatever its status.
				...(provider.sourceNote === undefined
					? []
					: [typography(h, { size: "xs", tone: "muted", as: "p" }, [provider.sourceNote])]),
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
	options: Readonly<{
		/** A credential write is in flight: the actions wait for it. */
		isBusy: boolean
		/** The viewer may add, replace and remove sources; without it no such action is offered. */
		canManage: boolean
	}>,
): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Sources",
			...(options.canManage
				? {
						action: button(
							h,
							{
								variant: "outline",
								size: "sm",
								isDisabled: options.isBusy,
								attributes: [h.OnClick(Message.ClickedAddSource())],
							},
							["Add source"],
						),
					}
				: undefined),
		}),
		vstack(
			h,
			{ as: "ul", gap: "0" },
			Arr.map(sources, (source) =>
				sourceRow(h, source, nowMs, timeZone, {
					...options,
					isOnlyOfProvider:
						Arr.filter(sources, (other) => other.provider === source.provider).length === 1,
				}),
			),
		),
	])
