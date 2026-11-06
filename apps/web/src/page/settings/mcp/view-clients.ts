import * as Policy from "@maple/domain/policy"
import type { V2McpConnection } from "@maple/domain/http/v2"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { skeletonList } from "@maple/views/ui/skeleton"
import { relativeTime } from "../../kit/relative-time"
import { sectionNote, settingsSection } from "../kit/section"
import { Message } from "./message"
import type { Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { timestamp } from "@maple/views/ui/timestamp"
import { Array as Arr } from "effect"

// `McpConnectedClientsSection`.

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ grants: ReadonlyArray<Policy.Permission>; nowMs: number; timeZone: string }>

const connectionRow = (h: H, connection: V2McpConnection, inputs: Inputs): Html =>
	hstack(h, { gap: "4", as: "li", className: "px-4 py-3", attributes: [h.Key(connection.id)] }, [
		h.div(
			[h.Class("min-w-0 flex-1")],
			[
				typography(h, { size: "sm", weight: "medium", truncate: true, as: "p" }, [
					connection.client_name,
				]),
				typography(h, { size: "xs", tone: "muted", truncate: true, as: "p" }, [
					connection.user_email ?? connection.user_id,
				]),
			],
		),
		h.p(
			[h.Class("hidden shrink-0 text-xs text-muted-foreground sm:block")],
			[
				"Connected ",
				timestamp(h, {
					value: connection.connected_at,
					timeZone: inputs.timeZone,
					nowMs: inputs.nowMs,
					label: formatDateInTimezone(connection.connected_at, { timeZone: inputs.timeZone }),
				}),
			],
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
	])

const content = (h: H, model: Model, inputs: Inputs): Html =>
	AsyncData.matchData(model.connections, {
		onEmpty: () => h.div([h.Class("p-4")], [skeletonList(h, { rows: 2 })]),
		onFailure: () => sectionNote(h, "Couldn't load connected clients."),
		onData: (rows) =>
			rows.length === 0
				? sectionNote(h, "No clients connected yet. Connect one above.")
				: h.ul(
						[h.Class("divide-y")],
						Arr.map(rows, (row) => connectionRow(h, row, inputs)),
					),
	})

export const connectedClientsSection = (h: H, model: Model, inputs: Inputs): Html =>
	settingsSection(
		h,
		{
			id: "mcp-clients-heading",
			title: "Connected clients",
			description: [
				Policy.has(inputs.grants, "mcp_connections:view_all")
					? "Clients that members approved with OAuth. Revoking one signs it out right away."
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
								typography(h, { tone: "foreground", weight: "medium" }, [
									model.revoking.client_name,
								]),
								" loses access right away and has to be approved again to reconnect.",
							],
				confirmLabel: "Revoke client",
				onConfirm: Message.ClickedConfirmRevoke(),
				isPending: model.isRevoking,
			}),
		],
	)
