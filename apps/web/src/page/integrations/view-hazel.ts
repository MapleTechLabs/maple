import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { item, itemContent, itemMedia } from "../../ui/item"
import { skeleton } from "../../ui/skeleton"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
	integrationIconPlate,
} from "../infra-integrations/kit/integration-empty"
import { HAZEL_ACCENT } from "./catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { disconnectDialog } from "./view-disconnect"

// `HazelIntegrationCard`.

type H = HtmlBuilder<Message>

const BRAND = { icon: "HazelIcon", accent: HAZEL_ACCENT } as const

const notConnected = (h: H, model: Model): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Alert delivery",
				title: "Alerts post to Hazel",
				description: "Fired alerts land straight in the channel you pick.",
			},
			{
				label: "Channel routing",
				title: "Workspace per destination",
				description: "Each destination picks the workspace and channel that gets notified.",
			},
			{
				label: "Escalations",
				title: "A step in your policies",
				description: "Use Hazel as a delivery step inside escalation chains.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, ["Alert destinations will appear here after connecting your workspace."]),
			button(
				h,
				{
					isDisabled: model.connect.isStarting || model.disconnect.isPending,
					isLoading: model.connect.isStarting,
					attributes: [h.OnClick(Message.ClickedConnect())],
				},
				[icon(h, "HazelIcon"), "Connect Hazel"],
			),
			integrationEmptyFooter(h, ["You'll authorize Maple in your Hazel workspace."]),
		]),
	])

const connected = (
	h: H,
	model: Model,
	status: {
		readonly externalUserEmail: string | null
		readonly externalUserId: string | null
		readonly scope: string | null
	},
): Html => {
	const busy = model.connect.isStarting || model.disconnect.isPending
	return item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
		itemMedia(h, {}, [integrationIconPlate(h, BRAND)]),
		itemContent(
			h,
			[
				h.div(
					[],
					[
						h.div(
							[h.Class("flex items-center gap-2")],
							[
								h.h3([h.Class("text-sm font-semibold")], ["Hazel"]),
								badge(h, { variant: "ok" }, ["Connected"]),
							],
						),
						h.p(
							[h.Class("mt-1 text-xs text-muted-foreground")],
							[
								"Forward Maple alerts into a Hazel workspace via OAuth. Once connected, create a Hazel destination to pick which workspace receives notifications.",
							],
						),
					],
				),
				h.div(
					[
						h.Class(
							"flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-2xs text-muted-foreground",
						),
					],
					[
						...(status.externalUserEmail !== null && status.externalUserEmail !== ""
							? [
									h.div(
										[h.Class("[overflow-wrap:anywhere]")],
										[
											h.span([h.Class("text-foreground")], [status.externalUserEmail]),
											" authorized this connection.",
										],
									),
								]
							: status.externalUserId !== null && status.externalUserId !== ""
								? [h.div([], [`External account: ${status.externalUserId}`])]
								: []),
						...(status.scope !== null && status.scope !== ""
							? [h.div([], [`Scopes: ${status.scope}`])]
							: []),
					],
				),
				h.div(
					[h.Class("flex flex-wrap gap-2")],
					[
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: busy,
								isLoading: model.connect.isStarting,
								attributes: [h.OnClick(Message.ClickedConnect())],
							},
							["Reconnect"],
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
					],
				),
				disconnectDialog(h, model, "hazel"),
			],
			"gap-2",
		),
	])
}

export const hazelCard = (h: H, model: Model): Html =>
	AsyncData.match(model.statuses.hazel.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Hazel integration",
				onRetry: Message.ClickedRetryStatus({ name: "hazel" }),
			}),
		onStale: ({ data }) => (data.connected ? connected(h, model, data) : notConnected(h, model)),
		onRefreshing: (data) => (data.connected ? connected(h, model, data) : notConnected(h, model)),
		onSuccess: (data) => (data.connected ? connected(h, model, data) : notConnected(h, model)),
	})
