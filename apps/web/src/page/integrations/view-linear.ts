import type { LinearIntegrationStatus } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "@maple/views/ui/heading"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { itemContent, mediaCard } from "@maple/views/ui/item"
import { skeletonBlock } from "@maple/views/ui/skeleton"
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
import { canManage, type Model } from "./model"
import { disconnectDialog } from "./view-disconnect"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

// The Linear card: connect, the connected workspace, and a revoked grant that needs a reconnect.

type H = HtmlBuilder<Message>

const BRAND = { icon: "LinearIcon", accent: LINEAR_ACCENT } as const

const ADMIN_ONLY = "Only org admins and engineers can change the Linear connection."

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
					isDisabled: !canManage(model) || model.connect.isStarting || model.disconnect.isPending,
					isLoading: model.connect.isStarting,
					attributes: [h.OnClick(Message.ClickedConnect())],
				},
				[icon(h, "LinearIcon"), "Connect Linear"],
			),
			integrationEmptyFooter(h, [
				canManage(model) ? "You'll authorize Maple in your Linear workspace." : ADMIN_ONLY,
			]),
		]),
	])

const connected = (h: H, model: Model, status: LinearIntegrationStatus): Html => {
	const busy = model.connect.isStarting || model.disconnect.isPending
	return mediaCard(h, integrationIconPlate(h, BRAND), [
		itemContent(
			h,
			[
				h.div(
					[],
					[
						hstack(h, { gap: "2" }, [
							heading(h, { level: 3, variant: "section" }, ["Linear"]),
							status.revoked
								? badge(h, { variant: "warn" }, ["Revoked"])
								: badge(h, { variant: "ok" }, ["Connected"]),
						]),
						typography(h, { size: "xs", tone: "muted", as: "p", className: "mt-1" }, [
							status.revoked
								? "Linear rejected Maple's access, so incidents no longer open or update issues. Reconnect to resume."
								: "Maple opens one Linear issue per alert rule, then comments as it fires again, changes severity or resolves. Create a Linear destination to pick the team.",
						]),
					],
				),
				...(status.workspaceName !== null && status.workspaceName !== ""
					? [
							h.div(
								[
									h.Class(
										"rounded-md bg-surface-sunken px-3 py-2 text-2xs text-muted-foreground",
									),
								],
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
				canManage(model)
					? hstack(h, { gap: "2", align: "stretch", wrap: true }, [
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
						])
					: typography(h, { size: "2xs", tone: "muted", as: "p" }, [ADMIN_ONLY]),
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
		onIdle: () => skeletonBlock(h, { height: "32" }),
		onLoading: () => skeletonBlock(h, { height: "32" }),
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
