import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { derivePlanetScaleSetup } from "../../components/integrations/planetscale-setup-steps"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "../../ui/heading"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { badge } from "../../ui/display"
import { item, itemActions, itemContent, itemMedia, mediaCard } from "../../ui/item"
import { panel } from "../../ui/panel"
import { skeletonBlock } from "../../ui/skeleton"
import { integrationIconPlate } from "../infra-integrations/kit/integration-empty"
import { liveChecklist } from "../kit/connect-flow"
import { catalogEntry } from "./catalog"
import { integrationNotice } from "./kit/notice"
import { Message } from "./message"
import type { Model } from "./model"
import { isWatchExpired } from "./planetscale"
import { disconnectDialog } from "./view-disconnect"
import { inventoryCountsOf } from "./flow-planetscale"
import { metricsHealth } from "./view-planetscale-parts"
import { pickerDialog } from "./view-planetscale-picker"
import { typography } from "../../ui/typography"
import { hstack, vstack } from "../../ui/stack"
import { strip } from "../../ui/rule"

// `PlanetScaleIntegrationCard` and `PlanetScaleWebhooks`: the source page's Connection tab.

type H = HtmlBuilder<Message>

const ENTRY = catalogEntry("planetscale")
const BRAND = { icon: "PlanetScaleIcon", accent: ENTRY.accent } as const

const reconnectButton = (h: H, model: Model): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "outline",
			isDisabled: model.connect.isStarting || model.disconnect.isPending,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		["Reconnect"],
	)

const header = (
	h: H,
	badgeNode: Html,
	line: ReadonlyArray<Html | string>,
	actions: ReadonlyArray<Html>,
): Html =>
	item(h, { className: "items-start gap-3 rounded-none p-4" }, [
		itemMedia(h, {}, [integrationIconPlate(h, BRAND)]),
		itemContent(
			h,
			[
				hstack(h, { gap: "2" }, [
					heading(h, { level: 3, variant: "section" }, ["PlanetScale"]),
					badgeNode,
				]),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "mt-1" }, line),
			],
			"gap-0",
		),
		...actions,
	])

type Webhooks = NonNullable<V2PlanetScaleIntegration["webhooks"]>

const WEBHOOK_EVENTS_LINE =
	"Out-of-memory restarts, storage thresholds, anomalies, and deploy requests arrive as they happen."

const webhookLine = (webhooks: Webhooks): string => {
	switch (webhooks.state) {
		case "active":
			return `Registered on ${webhooks.databases === 1 ? "your database" : `all ${webhooks.databases} databases`}. ${WEBHOOK_EVENTS_LINE}`
		case "pending":
			return webhooks.databases === 0
				? "Maple registers a webhook on each database once the inventory loads."
				: `Registering on your databases: ${webhooks.registered_databases} of ${webhooks.databases} so far.`
		case "failing":
			return `Registered on ${webhooks.registered_databases} of ${webhooks.databases} databases. The last attempt failed:`
		case "needs_reauthorization":
			return "This authorization predates webhooks. Reconnect so Maple can register them on your databases."
	}
}

/** `PlanetScaleWebhooks`: Maple registers them itself, so this only reports. */
const webhookStatus = (h: H, model: Model, webhooks: Webhooks): Html =>
	panel(h, {}, [
		item(h, { className: "items-start gap-3 rounded-none p-4" }, [
			itemContent(
				h,
				[
					hstack(h, { gap: "2" }, [
						heading(h, { level: 3, variant: "section" }, ["Webhooks"]),
						webhooks.state === "active"
							? badge(h, { variant: "ok" }, ["Active"])
							: webhooks.state === "pending"
								? badge(h, { variant: "secondary" }, ["Registering"])
								: badge(h, { variant: "warn" }, ["Needs attention"]),
					]),
					typography(h, { size: "xs", tone: "muted", as: "p", className: "mt-1" }, [
						webhookLine(webhooks),
					]),
					...(webhooks.state === "failing" && webhooks.last_error !== null
						? [
								h.p(
									[
										h.Class(
											"mt-2 break-all rounded-md bg-surface-sunken p-2 font-mono text-xs text-muted-foreground",
										),
									],
									[webhooks.last_error],
								),
							]
						: []),
				],
				"gap-0",
			),
			...(webhooks.state === "needs_reauthorization"
				? [itemActions(h, [reconnectButton(h, model)])]
				: []),
		]),
	])

/** The first-metrics watch ran out; "Check again" restarts it. */
const watchExpired = (h: H): Html =>
	h.div(
		[h.Class("mt-3 flex flex-col items-start gap-2")],
		[
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Still no metrics after 30 minutes, so this stopped checking on its own.",
			]),
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					attributes: [h.OnClick(Message.ClickedPlanetscaleCheckAgain())],
				},
				["Check again"],
			),
		],
	)

const connectedView = (h: H, model: Model, status: V2PlanetScaleIntegration, timeZone: string): Html => {
	const setup = derivePlanetScaleSetup(status, model.nowMs, inventoryCountsOf(model))
	const busy = model.connect.isStarting || model.disconnect.isPending
	const organization = typography(h, { tone: "foreground", weight: "medium" }, [status.organization ?? ""])
	const webhooks = status.webhooks ?? null
	const isLive = setup.live === "healthy"
	return vstack(h, { gap: "4" }, [
		panel(h, {}, [
			header(
				h,
				isLive
					? badge(h, { variant: "ok" }, ["Connected"])
					: setup.live === "attention"
						? badge(h, { variant: "warn" }, ["Needs attention"])
						: badge(h, { variant: "secondary" }, ["Starting"]),
				isLive
					? ["Streaming branch metrics from", " ", organization]
					: ["Connected to", " ", organization],
				[
					itemActions(
						h,
						[
							...(setup.accessBlocked ? [reconnectButton(h, model)] : []),
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									isDisabled: busy,
									attributes: [h.OnClick(Message.ClickedChangeOrganization())],
								},
								["Edit data"],
							),
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									isDisabled: busy,
									isLoading: model.disconnect.isPending,
									attributes: [h.OnClick(Message.ClickedDisconnect())],
								},
								["Disconnect"],
							),
							disconnectDialog(h, model, "planetscale"),
						],
						"shrink-0 gap-1.5",
					),
				],
			),
			isLive
				? metricsHealth(h, model, status, timeZone)
				: strip(h, { kind: "block" },
						[
							liveChecklist(h, { title: "Checking the connection", rows: setup.checks }),
							...(isWatchExpired(model.planetscaleCard, model.nowMs) ? [watchExpired(h)] : []),
						],
					),
		]),
		...(webhooks === null ? [] : [webhookStatus(h, model, webhooks)]),
		pickerDialog(h, model),
	])
}

export const planetscaleCard = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.statuses.planetscale.data, {
		onIdle: () => skeletonBlock(h, { height: "40" }),
		onLoading: () => skeletonBlock(h, { height: "40" }),
		onFailure: () => statusFailed(h),
		onStale: () => statusFailed(h),
		onRefreshing: (status) => byStatus(h, model, status, timeZone),
		onSuccess: (status) => byStatus(h, model, status, timeZone),
	})

const byStatus = (h: H, model: Model, status: V2PlanetScaleIntegration, timeZone: string): Html =>
	status.connected
		? connectedView(h, model, status, timeZone)
		: planetscaleReconnect(
				h,
				status.pending_org_selection
					? "PlanetScale is authorized, but no organization is picked yet."
					: "PlanetScale is not connected.",
			)

/** A source page whose connection was removed: the way back is the connect flow. */
const planetscaleReconnect = (h: H, text: string): Html =>
	integrationNotice(h, {
		message: text,
		action: linkButton(
			h,
			{ size: "sm", href: hrefOf(AppRoute.SourcesNew({ search: { integration: "planetscale" } })) },
			["Reconnect"],
		),
	})

/** A failed status read is not "not connected": no connect offer over a maybe-authorized org. */
const statusFailed = (h: H): Html =>
	mediaCard(h, integrationIconPlate(h, BRAND), [
		itemContent(h, [
			heading(h, { level: 3, variant: "section" }, ["PlanetScale"]),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Couldn't load the PlanetScale connection status. Refresh the page to try again.",
			]),
		]),
	])
