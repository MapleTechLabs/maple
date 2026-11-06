import type { CloudflareIntegrationStatus, CloudflareUsageResponse } from "@maple/domain/http"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { badge } from "@maple/views/ui/display"
import { button } from "@maple/views/ui/button"
import { delta } from "@maple/views/ui/delta"
import { icon } from "@maple/views/ui/icon"
import { item, itemActions, itemContent, itemMedia } from "@maple/views/ui/item"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { skeleton } from "@maple/views/ui/skeleton"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { statRail, statRailItem } from "../kit/stat-rail"
import { ingestBanner, ingestPhaseOf } from "../infra-integrations/cloudflare/ingest"
import { CLOUDFLARE_ACCENT } from "./catalog"
import {
	accountErrorOf,
	type ConnectedAccountEntry,
	connectedAccountsOf,
	toRowUsage,
	workerEntryOf,
	workerServicesOf,
	zoneEntriesOf,
} from "./cloudflare-derive"
import { Message } from "./message"
import type { Model } from "./model"
import { workersCard, zoneBoard } from "./view-cloudflare-board"
import { zonesDialog } from "./view-cloudflare-zones"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The connected `CloudflareAccountCard` and `CloudflareStatCards`.

type H = HtmlBuilder<Message>

const accountsStrip = (h: H, accounts: ReadonlyArray<ConnectedAccountEntry>): Html | null =>
	accounts.length < 2
		? null
		: panel(h, { className: "border-border-subtle" }, [
				panelHeader(h, {
					title: `Connected accounts (${accounts.length})`,
					className: "border-border-subtle",
				}),
				h.ul(
					[h.Class("divide-y divide-border-subtle")],
					Arr.map(accounts, (account) =>
						item(h, { variant: "flush", size: "lg", className: "py-2.5", tag: "li" }, [
							itemMedia(h, {}, [
								icon(h, "CloudflareMonoIcon", {
									size: 16,
									className: "text-muted-foreground",
								}),
							]),
							itemContent(
								h,
								[
									truncatedText(h, {
										text: account.accountName ?? account.accountId,
										className: typographyClass({ size: "sm", weight: "medium" }),
									}),
									truncatedText(h, {
										text: account.accountId,
										mono: true,
										className: typographyClass({ size: "2xs", tone: "muted" }),
									}),
								],
								"gap-0",
							),
							itemActions(
								h,
								[
									...(account.revoked
										? [badge(h, { variant: "crit" }, ["Reconnect required"])]
										: !account.analyticsCapable
											? [badge(h, { variant: "warn" }, ["Needs updated access"])]
											: []),
									typography(h, { size: "xs", tone: "muted" }, [
										countLabel(account.zoneCount, "zone"),
									]),
								],
								"gap-1.5",
							),
						]),
					),
				),
			])

/** `TrafficDelta`: quiet unless traffic moved. */
const trafficDelta = (h: H, usage: CloudflareUsageResponse): Html | string => {
	const previous = usage.previousTotalRequests
	if (previous === null || previous === undefined) return "Requests · last 24h"
	if (previous === 0) return usage.totalRequests > 0 ? "First 24h of traffic" : "Requests · last 24h"
	return delta(h, {
		current: usage.totalRequests,
		previous,
		flatThreshold: 0.005,
		muteWorse: true,
		suffix: "vs previous 24h",
	})
}

const statCards = (h: H, usage: CloudflareUsageResponse | null): Html => {
	if (usage === null)
		return h.div(
			[h.Class("flex flex-col gap-3 sm:flex-row")],
			Arr.map([0, 1, 2], () => skeleton(h, "h-[104px] flex-1 rounded-md")),
		)
	const workerServices = workerServicesOf(usage)
	const totalPoints = usage.totalRequests > 0 ? toRowUsage(usage, usage.services).points : undefined
	const active = Arr.filter(workerServices, (service) => service.totalRequests > 0)
	const invocations = Arr.reduce(workerServices, 0, (sum, service) => sum + service.totalRequests)
	const workerPoints = invocations > 0 ? toRowUsage(usage, workerServices).points : undefined
	return statRail(h, { columns: 3 }, [
		statRailItem(h, {
			eyebrow: "Traffic · 24h",
			value: formatNumber(usage.totalRequests),
			spark: totalPoints,
			sparkColor: CLOUDFLARE_ACCENT,
			subline: trafficDelta(h, usage),
		}),
		statRailItem(h, {
			eyebrow: "Workers",
			value: `${active.length} active`,
			spark: workerPoints,
			sparkColor: CLOUDFLARE_ACCENT,
			subline:
				invocations > 0
					? `${formatNumber(invocations)} invocations · on service map`
					: "Scripts appear once they serve traffic",
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "Firewall · 24h",
			value: `${formatNumber(usage.firewallBlockedEvents ?? 0)} blocked`,
			subline: "DNS analytics alongside traces",
			action: h.a(
				[
					h.Href(hrefOf(AppRoute.InfraCloudflare({ search: {} }))),
					h.Class(
						"inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground hover:text-foreground active:text-foreground",
					),
				],
				["Open", icon(h, "ArrowRightIcon", { size: 12 })],
			),
		}),
	])
}

const connectAction = (h: H, model: Model, label: string, variant?: "outline"): Html =>
	button(
		h,
		{
			size: "sm",
			variant,
			isDisabled: model.connect.isStarting,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		[label],
	)

/** The whole-account banner: missing analytics scopes, or an account-wide failure. */
const accountBanner = (h: H, model: Model, status: CloudflareIntegrationStatus): Html | null => {
	if (!status.analyticsCapable)
		return alert(h, { variant: "warn" }, [
			icon(h, "CircleWarningIcon"),
			alertTitle(h, ["Update access to collect analytics"]),
			alertDescription(h, [
				"Maple needs updated Cloudflare permissions to read traffic analytics from this account.",
			]),
			alertAction(h, [connectAction(h, model, "Update access")]),
		])
	const error = accountErrorOf(status)
	if (error === null) return null
	return alert(h, { variant: error.tone }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["Traffic collection paused"]),
		alertDescription(h, [
			h.span([], [error.summary]),
			...(error.summary !== error.raw
				? [
						h.span(
							[
								h.DataAttribute("base-ui-tooltip-trigger", ""),
								h.Class(
									"w-fit cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted underline-offset-2",
								),
								h.DataAttribute("slot", "tooltip-trigger"),
							],
							["Error details"],
						),
					]
				: []),
		]),
		alertAction(h, [connectAction(h, model, "Reconnect", "outline")]),
	])
}

export const cloudflareConnected = (
	h: H,
	model: Model,
	status: CloudflareIntegrationStatus,
	timeZone: string,
): Html => {
	const usageData = model.cloudflareCard.usage.data
	const usage = AsyncData.isSuccess(usageData) || AsyncData.isRefreshing(usageData) ? usageData.data : null
	const usageFailed = AsyncData.isFailure(usageData) || AsyncData.isStale(usageData)
	const phase = ingestPhaseOf(status, usage, model.nowMs)
	const banner = accountBanner(h, model, status)
	const zones = zoneEntriesOf(status, usage)
	const workerServices = workerServicesOf(usage)
	const hasWorkers =
		status.workers !== null && status.workers !== undefined ? true : workerServices.length > 0
	const hasReadout = status.zones.length > 0 || hasWorkers || (usage !== null && usage.services.length > 0)
	const phaseBanner = banner === null && phase !== null ? ingestBanner(h, phase) : null
	const strip = accountsStrip(h, connectedAccountsOf(status))
	return vstack(h, { gap: "4" }, [
		...(strip === null ? [] : [strip]),
		...(phaseBanner === null ? [] : [phaseBanner]),
		...(hasReadout
			? [
					...(usageFailed ? [] : [statCards(h, usage)]),
					...(zones.length === 0 && banner !== null ? [banner] : []),
					h.div(
						[h.Class("flex flex-col gap-4 lg:flex-row lg:items-start")],
						[
							...(zones.length > 0
								? [
										zoneBoard(
											h,
											model,
											zones,
											usage !== null,
											banner,
											"min-w-0 flex-1",
											timeZone,
										),
									]
								: []),
							...(hasWorkers
								? [
										workersCard(
											h,
											model,
											workerEntryOf(status, usage),
											workerServices,
											usage !== null,
											timeZone,
										),
									]
								: []),
						],
					),
				]
			: [
					...(banner === null ? [] : [banner]),
					...(banner !== null || phase === null
						? [
								typography(h, { size: "xs", tone: "muted", as: "p" }, [
									"Your zones and Workers will appear here once collection starts.",
								]),
							]
						: []),
				]),
		zonesDialog(h, model),
	])
}
