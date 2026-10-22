import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { truncatedCellStyles } from "@maple/ui/styles/ui/table"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import { badge } from "../../../../ui/display"
import { icon } from "../../../../ui/icon"
import { skeletonList } from "../../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../../ui/table"
import { truncatedText } from "../../../../ui/truncated-text"
import { relativeTime } from "../../../kit/relative-time"
import { settingsSection, settingsSections } from "../../kit/section"
import { Message, type Model, type SessionRow } from "./model"

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ nowMs: number; timeZone: string }>

const sessionRow = (h: H, model: Model, session: SessionRow, inputs: Inputs): Html => {
	const isCurrent = session.id === model.currentSessionId
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex items-center gap-2.5")],
						[
							icon(h, session.isMobile ? "MobileIcon" : "ComputerIcon", {
								size: 16,
								className: "shrink-0 text-muted-foreground",
							}),
							truncatedText(h, { text: session.device, className: "text-xs font-medium" }),
							...(isCurrent
								? [badge(h, { variant: "secondary", className: "shrink-0" }, ["This device"])]
								: []),
						],
					),
				],
				cn(truncatedCellStyles),
			),
			tableCell(h, [session.location], "text-muted-foreground hidden text-xs sm:table-cell"),
			tableCell(
				h,
				[
					relativeTime(h, {
						value: new Date(session.lastActiveAtMs).toISOString(),
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
					}),
				],
				"text-muted-foreground text-xs",
			),
			// Revoking the current session would sign the user out from inside the page; Log out does that.
			tableCell(
				h,
				isCurrent
					? []
					: [
							button(
								h,
								{
									variant: "ghost",
									size: "sm",
									attributes: [h.OnClick(Message.ClickedSignOut({ session }))],
								},
								["Sign out"],
							),
						],
			),
		],
		undefined,
		[h.Key(session.id)],
	)
}

const body = (h: H, model: Model, inputs: Inputs): ReadonlyArray<Html> => {
	const state = model.state
	switch (state._tag) {
		case "Loading":
			return [skeletonList(h, { rows: 2, rowClassName: "h-9", gap: "2" })]
		case "Failed":
			return [
				h.div(
					[h.Class("flex items-center justify-between gap-4")],
					[
						h.p([h.Class(cn("text-sm", TONE_TEXT.crit))], [state.message]),
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								attributes: [h.OnClick(Message.ClickedRetry())],
							},
							["Retry"],
						),
					],
				),
			]
		case "Ready":
			return [
				table(h, {}, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Device"]),
							tableHead(h, ["Location"], "hidden sm:table-cell"),
							tableHead(h, ["Last active"]),
							tableHead(h, [], "w-24"),
						]),
					]),
					tableBody(
						h,
						state.sessions.map((session) => sessionRow(h, model, session, inputs)),
					),
				]),
			]
	}
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	settingsSections(h, "standard", [
		settingsSection(
			h,
			{
				id: "account-sessions",
				title: "Active sessions",
				description: [
					"Devices currently signed in to your account. Sign out any you do not recognise.",
				],
				padded: model.state._tag !== "Ready",
			},
			body(h, model, inputs),
		),
		confirmDialog(h, {
			slotId: "account-revoke-session",
			model: model.revokeDialog,
			toParentMessage: (message) => Message.GotRevokeDialogMessage({ message }),
			title: "Sign out this device?",
			description: `${model.revoking?.device ?? "This session"} will need to sign in again to reach Maple.`,
			confirmLabel: "Sign out",
			isPending: model.isRevoking,
			onConfirm: Message.ClickedConfirmSignOut(),
		}),
	]),
)
