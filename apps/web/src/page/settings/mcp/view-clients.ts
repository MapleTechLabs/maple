import type { V2McpConnection } from "@maple/domain/http/v2"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { skeletonList } from "../../../ui/skeleton"
import { relativeTime } from "../../kit/relative-time"
import { sectionNote, settingsSection } from "../kit/section"
import { Message } from "./message"
import type { Model } from "./model"

// `McpConnectedClientsSection`.

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ isAdmin: boolean; nowMs: number; timeZone: string }>

const connectionRow = (h: H, connection: V2McpConnection, inputs: Inputs): Html =>
	h.li(
		[h.Key(connection.id), h.Class("flex items-center gap-4 px-4 py-3")],
		[
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.p([h.Class("truncate text-sm font-medium")], [connection.client_name]),
					h.p(
						[h.Class("truncate text-xs text-muted-foreground")],
						[connection.user_email ?? connection.user_id],
					),
				],
			),
			h.p(
				[h.Class("hidden shrink-0 text-xs text-muted-foreground sm:block")],
				["Connected ", formatDateInTimezone(connection.connected_at, { timeZone: inputs.timeZone })],
			),
			h.p(
				[h.Class("hidden shrink-0 text-xs text-muted-foreground md:block")],
				[
					"Last refreshed ",
					relativeTime(h, {
						value: connection.last_refreshed_at,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
					}),
				],
			),
			button(
				h,
				{
					variant: "ghost",
					size: "sm",
					className: "shrink-0 text-destructive",
					attributes: [h.OnClick(Message.ClickedRevoke({ connectionId: connection.id }))],
				},
				["Revoke"],
			),
		],
	)

const content = (h: H, model: Model, inputs: Inputs): Html =>
	AsyncData.matchData(model.connections, {
		onEmpty: () => h.div([h.Class("p-4")], [skeletonList(h, { rows: 2 })]),
		onFailure: () => sectionNote(h, "Connected clients could not be loaded."),
		onData: (rows) =>
			rows.length === 0
				? sectionNote(h, "No clients connected yet. Connect one above.")
				: h.ul(
						[h.Class("divide-y")],
						rows.map((row) => connectionRow(h, row, inputs)),
					),
	})

export const connectedClientsSection = (h: H, model: Model, inputs: Inputs): Html =>
	settingsSection(
		h,
		{
			id: "mcp-clients-heading",
			title: "Connected clients",
			description: [
				inputs.isAdmin
					? "Clients members approved with OAuth. Revoking signs the client out right away."
					: "Clients you approved with OAuth. Revoking signs the client out right away.",
			],
			padded: false,
		},
		[
			content(h, model, inputs),
			confirmDialog(h, {
				slotId: "mcp-revoke-dialog",
				model: model.revokeDialog,
				toParentMessage: (message) => Message.GotRevokeDialogMessage({ message }),
				title: "Revoke this client?",
				description:
					model.revoking === null
						? []
						: [
								h.span(
									[h.Class("font-medium text-foreground")],
									[model.revoking.client_name],
								),
								" loses access right away and has to be approved again to reconnect.",
							],
				confirmLabel: "Revoke",
				onConfirm: Message.ClickedConfirmRevoke(),
				isPending: model.isRevoking,
			}),
		],
	)
