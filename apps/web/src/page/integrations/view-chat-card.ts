import type { ChatConnectorId } from "@maple/domain/primitives"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import { errorState } from "../../ui/error-state"
import { item, itemContent, itemMedia } from "../../ui/item"
import { statusDot } from "../../ui/status-dot"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
	integrationIconPlate,
} from "../infra-integrations/kit/integration-empty"
import { relativeTime } from "../kit/relative-time"
import { catalogEntry, chatIntegrationId, chatManifestOf } from "./catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { chatConnectorStatus } from "./update-chat"
import { chatCardLoading, identityRow, monoGlyph } from "./view-chat"
import { entryBrand } from "./view-entry"

// `ChatIntegrationCard`.
// TODO(clerk): `useIsOrgAdmin` (self-hosted is the root admin) and `WorkspaceSettings`, which renders
// nothing until a manifest declares settings fields (none does).

type H = HtmlBuilder<Message>

const IS_ADMIN = true

export const chatCard = (h: H, model: Model, connector: ChatConnectorId, timeZone: string): Html => {
	const manifest = chatManifestOf(connector)
	if (manifest === undefined) return h.empty
	const status = chatConnectorStatus(model)
	const data = model.statuses.chat.data
	if (status === null && (AsyncData.isIdle(data) || AsyncData.isLoading(data))) return chatCardLoading(h)
	if (status === null && AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: `Couldn't load the ${manifest.name} integration`,
			onRetry: Message.ClickedRetryStatus({ name: "chat" }),
		})
	const entry = catalogEntry(chatIntegrationId(connector))
	const brand = { ...entryBrand(h, entry), backerGlyph: (size: number) => monoGlyph(h, manifest, size) }
	const workspaces = status?.workspaces ?? []
	const available = status?.available === true
	const busy = model.chatCard.busy
	const connectDisabled = !IS_ADMIN || !available || busy !== null

	if (workspaces.length === 0)
		return integrationEmpty(h, [
			integrationEmptyCard(h, [
				integrationEmptyMedia(h, brand),
				integrationEmptyHint(h, [manifest.description]),
				button(
					h,
					{
						isDisabled: connectDisabled,
						isLoading: busy === "install",
						attributes: [h.OnClick(Message.ClickedChatInstall())],
					},
					[monoGlyph(h, manifest), `Add to ${manifest.name}`],
				),
				integrationEmptyFooter(h, [
					!available
						? `${manifest.name} is not configured in this Maple deployment. Contact support.`
						: `You'll approve the install in ${manifest.name}.`,
				]),
			]),
		])

	const confirmWorkspace = workspaces.find((workspace) => workspace.id === model.chatCard.confirmId)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			...workspaces.map((workspace) =>
				item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
					itemMedia(h, {}, [integrationIconPlate(h, brand)]),
					itemContent(
						h,
						[
							h.div(
								[h.Class("flex items-center gap-2")],
								[
									h.h3(
										[h.Class("min-w-0 text-sm font-semibold [overflow-wrap:anywhere]")],
										[workspace.name],
									),
									h.span(
										[h.Class("flex items-center gap-1.5 text-xs text-muted-foreground")],
										[statusDot(h, { tone: "ok", size: "lg" }), "Connected"],
									),
								],
							),
							h.p(
								[h.Class("text-xs text-muted-foreground")],
								[
									status?.supports_identity === true
										? `Linked to your organization. Maple answers only people who have linked their ${manifest.name} account, as their own Maple user.`
										: `Linked to your organization, for everyone in this workspace. No ${manifest.name} account is tied to an individual Maple user.`,
								],
							),
							relativeTime(h, {
								value: workspace.created_at,
								nowMs: model.nowMs,
								timeZone,
								prefix: "Connected",
								className: "text-2xs text-muted-foreground",
							}),
							h.div(
								[],
								[
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											isDisabled: !IS_ADMIN || busy !== null,
											attributes: [
												h.OnClick(
													Message.ClickedChatDisconnect({
														workspaceId: workspace.id,
													}),
												),
											],
										},
										["Disconnect"],
									),
								],
							),
						],
						"gap-2",
					),
				]),
			),
			...(status?.supports_identity === true
				? [identityRow(h, model, manifest.name, status.identity)]
				: []),
			h.div(
				[],
				[
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: connectDisabled,
							isLoading: busy === "install",
							attributes: [h.OnClick(Message.ClickedChatInstall())],
						},
						["Add another workspace"],
					),
				],
			),
			confirmDialog(h, {
				slotId: "integration-disconnect",
				model: model.disconnect.dialog,
				toParentMessage: (message) => Message.GotDisconnectDialogMessage({ message }),
				title: confirmWorkspace ? `Disconnect ${confirmWorkspace.name}?` : "Disconnect workspace",
				description: `${confirmWorkspace ? confirmWorkspace.name : "This workspace"} is unlinked from your organization immediately. Removing the bot from the workspace itself is done in ${manifest.name}.`,
				confirmLabel: "Disconnect",
				onConfirm: Message.ConfirmedDisconnect(),
				isPending: busy !== null && busy === model.chatCard.confirmId,
			}),
		],
	)
}
