import type { LinearIntegrationStatus } from "@maple/domain/http"
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
import { LINEAR_ACCENT } from "./catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { disconnectDialog } from "./view-disconnect"

// The Linear card: connect, the connected workspace, and a revoked grant that needs a reconnect.

type H = HtmlBuilder<Message>

const BRAND = { icon: "LinearIcon", accent: LINEAR_ACCENT } as const

const ADMIN_ONLY = "Only org admins can change the Linear connection."

const notConnected = (h: H, model: Model): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Alert issues",
				title: "One issue per rule",
				description:
					"A firing rule opens one Linear issue in the team you pick. Severity sets its priority.",
			},
			{
				label: "Updates",
				title: "Comments as it changes",
				description:
					"Firing again, a severity change or a resolve comments on the same issue. A closed issue reopens if the rule fires within 24 hours.",
			},
			{
				label: "Attribution",
				title: "Created by Maple",
				description: "Issues and comments show Maple as the author, not a teammate.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, [
				"Linear destinations will appear here after connecting your workspace.",
			]),
			button(
				h,
				{
					isDisabled: !model.isAdmin || model.connect.isStarting || model.disconnect.isPending,
					isLoading: model.connect.isStarting,
					attributes: [h.OnClick(Message.ClickedConnect())],
				},
				[icon(h, "LinearIcon"), "Connect Linear"],
			),
			integrationEmptyFooter(h, [
				model.isAdmin ? "You'll authorize Maple in your Linear workspace." : ADMIN_ONLY,
			]),
		]),
	])

const connected = (h: H, model: Model, status: LinearIntegrationStatus): Html => {
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
								h.h3([h.Class("text-sm font-semibold")], ["Linear"]),
								status.revoked
									? badge(h, { variant: "warn" }, ["Revoked"])
									: badge(h, { variant: "ok" }, ["Connected"]),
							],
						),
						h.p(
							[h.Class("mt-1 text-xs text-muted-foreground")],
							[
								status.revoked
									? "Linear rejected Maple's access, so incidents no longer open or update issues. Reconnect to resume."
									: "Maple opens one Linear issue per alert rule, then comments as it fires again, changes severity or resolves. Create a Linear destination to pick the team.",
							],
						),
					],
				),
				...(status.workspaceName !== null && status.workspaceName !== ""
					? [
							h.div(
								[h.Class("rounded-md bg-surface-sunken px-3 py-2 text-2xs text-muted-foreground")],
								[
									h.div(
										[h.Class("[overflow-wrap:anywhere]")],
										[
											"Workspace ",
											h.span([h.Class("text-foreground")], [status.workspaceName]),
										],
									),
								],
							),
						]
					: []),
				model.isAdmin
					? h.div(
							[h.Class("flex flex-wrap gap-2")],
							[
								button(
									h,
									{
										size: "sm",
										variant: status.revoked ? "default" : "outline",
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
						)
					: h.p([h.Class("text-2xs text-muted-foreground")], [ADMIN_ONLY]),
				disconnectDialog(h, model, "linear"),
			],
			"gap-2",
		),
	])
}

const byState = (h: H, model: Model, data: LinearIntegrationStatus): Html =>
	data.connected ? connected(h, model, data) : notConnected(h, model)

export const linearCard = (h: H, model: Model): Html =>
	AsyncData.match(model.statuses.linear.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the Linear integration",
				onRetry: Message.ClickedRetryStatus({ name: "linear" }),
			}),
		onStale: ({ data }) => byState(h, model, data),
		onRefreshing: (data) => byState(h, model, data),
		onSuccess: (data) => byState(h, model, data),
	})
