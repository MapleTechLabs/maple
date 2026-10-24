import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import {
	derivePlanetScaleSetup,
	metricsAuthOf,
	metricsLastError,
} from "../../components/integrations/planetscale-setup-steps"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { badge } from "../../ui/display"
import { icon } from "../../ui/icon"
import { item, itemActions, itemContent, itemMedia } from "../../ui/item"
import { panel } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyHint,
	integrationEmptyMedia,
	integrationIconPlate,
} from "../infra-integrations/kit/integration-empty"
import { catalogEntry } from "./catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { isWatchExpired } from "./planetscale"
import { disconnectDialog } from "./view-disconnect"
import { metricsHealth, setupChecklist } from "./view-planetscale-parts"
import { orgPicker, pickerDialog } from "./view-planetscale-picker"

// `PlanetScaleIntegrationCard`, `FirstMetricsDetail` and `PlanetScaleWebhooks`.

type H = HtmlBuilder<Message>

const ENTRY = catalogEntry("planetscale")
const BRAND = { icon: "PlanetScaleIcon", accent: ENTRY.accent } as const

const connectButton = (h: H, model: Model, label: string, withIcon: boolean): Html =>
	button(
		h,
		{
			size: withIcon ? undefined : "sm",
			isDisabled: model.connect.isStarting || model.disconnect.isPending,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		withIcon ? [icon(h, "PlanetScaleIcon"), label] : [label],
	)

const notConnected = (h: H, model: Model): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Service map",
				title: "Databases join the map",
				description: "Linked to the services that query them, with branches tracked automatically.",
			},
			{
				label: "Query insights",
				title: "Top queries per branch",
				description: "Calls, rows read, and time per query — proxied straight from PlanetScale.",
			},
			{
				label: "Branch health",
				title: "CPU, memory, replication",
				description: "Connections and replication lag per branch, collected every 5 minutes.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, ["Your databases and branches will appear here after connecting."]),
			connectButton(h, model, "Connect PlanetScale", true),
		]),
	])

/** `FirstMetricsDetail`: the collection error, a reassurance while Maple waits, or "Check again". */
const firstMetricsDetail = (h: H, model: Model, status: V2PlanetScaleIntegration): Html => {
	const error = metricsLastError(status)
	if (error !== null)
		return h.p(
			[h.Class("break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground")],
			[error],
		)
	if (isWatchExpired(model.planetscaleCard, model.nowMs))
		return h.div(
			[h.Class("flex flex-col items-start gap-2")],
			[
				h.p(
					[h.Class("text-xs text-muted-foreground")],
					["Still no metrics after 30 minutes, so this stopped checking on its own."],
				),
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
	if (metricsAuthOf(status) === "api")
		return h.p(
			[h.Class("text-xs text-muted-foreground")],
			["The first poll usually lands within 10 minutes. This updates on its own."],
		)
	const watchedForMs = model.nowMs - (model.planetscaleCard.watchStartedAt ?? model.nowMs)
	return h.p(
		[h.Class("text-xs text-muted-foreground")],
		[
			watchedForMs < 3 * 60 * 1000
				? "Usually under a minute. This updates on its own."
				: "Still nothing after a few minutes. Check that the service token still exists in PlanetScale.",
		],
	)
}

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
				h.div(
					[h.Class("flex items-center gap-2")],
					[h.h3([h.Class("text-sm font-semibold")], ["PlanetScale"]), badgeNode],
				),
				h.p([h.Class("mt-1 text-xs text-muted-foreground")], line),
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
			return "This authorization predates webhooks. Reauthorize so Maple can register them on your databases."
	}
}

/** `PlanetScaleWebhooks`: Maple registers them itself, so this only reports. */
const webhookStatus = (h: H, model: Model, webhooks: Webhooks): Html =>
	panel(h, {}, [
		item(h, { className: "items-start gap-3 rounded-none p-4" }, [
			itemContent(
				h,
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.h3([h.Class("text-sm font-semibold")], ["Webhooks"]),
							webhooks.state === "active"
								? badge(h, { variant: "ok" }, ["Active"])
								: webhooks.state === "pending"
									? badge(h, { variant: "secondary" }, ["Registering"])
									: badge(h, { variant: "warn" }, ["Needs attention"]),
						],
					),
					h.p([h.Class("mt-1 text-xs text-muted-foreground")], [webhookLine(webhooks)]),
					...(webhooks.state === "failing" && webhooks.last_error !== null
						? [
								h.p(
									[
										h.Class(
											"mt-2 break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground",
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
				? [itemActions(h, [connectButton(h, model, "Reauthorize", false)])]
				: []),
		]),
	])

const connectedView = (h: H, model: Model, status: V2PlanetScaleIntegration, timeZone: string): Html => {
	const setup = derivePlanetScaleSetup(status, model.nowMs)
	const busy = model.connect.isStarting || model.disconnect.isPending
	const organization = h.span([h.Class("font-medium text-foreground")], [status.organization ?? ""])
	const webhooks = status.webhooks ?? null
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			panel(h, {}, [
				header(
					h,
					setup.complete
						? badge(h, { variant: "ok" }, ["Connected"])
						: badge(h, { variant: "warn" }, [
								"Step ",
								String(setup.activeStepNumber ?? ""),
								" of ",
								String(setup.steps.length),
							]),
					setup.complete
						? ["Streaming branch metrics from", " ", organization]
						: [
								"Connected to",
								" ",
								organization,
								" — inventory, insights, and webhooks are live.",
							],
					[
						itemActions(
							h,
							[
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										isDisabled: busy,
										attributes: [h.OnClick(Message.ClickedChangeOrganization())],
									},
									["Change organization"],
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
				...(setup.complete
					? []
					: [
							h.div(
								[h.Class("border-t border-border/60 p-4")],
								[
									setupChecklist(h, setup.steps, (id) =>
										id === "connected"
											? connectButton(h, model, "Reconnect", false)
											: id === "permissions"
												? connectButton(
														h,
														model,
														"Reauthorize with read_databases",
														false,
													)
												: firstMetricsDetail(h, model, status),
									),
								],
							),
						]),
				...(setup.complete ? [metricsHealth(h, model, status, timeZone)] : []),
			]),
			...(webhooks === null ? [] : [webhookStatus(h, model, webhooks)]),
			pickerDialog(h, model),
		],
	)
}

const pendingSelection = (h: H, model: Model): Html =>
	panel(h, {}, [
		header(
			h,
			badge(h, { variant: "secondary" }, ["Authorized"]),
			["The authorization covers multiple PlanetScale organizations — choose which one to connect."],
			[],
		),
		h.div([h.Class("border-t border-border/60 p-4")], [orgPicker(h, model, "Disconnect")]),
		disconnectDialog(h, model, "planetscale"),
	])

export const planetscaleCard = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.statuses.planetscale.data, {
		onIdle: () => skeleton(h, "h-40 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-40 w-full rounded-md"),
		onFailure: () => statusFailed(h),
		onStale: () => statusFailed(h),
		onRefreshing: (status) => byStatus(h, model, status, timeZone),
		onSuccess: (status) => byStatus(h, model, status, timeZone),
	})

const byStatus = (h: H, model: Model, status: V2PlanetScaleIntegration, timeZone: string): Html =>
	status.connected
		? connectedView(h, model, status, timeZone)
		: status.pending_org_selection
			? pendingSelection(h, model)
			: notConnected(h, model)

/** A failed status read is not "not connected": no connect offer over a maybe-authorized org. */
const statusFailed = (h: H): Html =>
	item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
		itemMedia(h, {}, [integrationIconPlate(h, BRAND)]),
		itemContent(h, [
			h.h3([h.Class("text-sm font-semibold")], ["PlanetScale"]),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				["Couldn't load the PlanetScale connection status — refresh the page to try again."],
			),
		]),
	])
