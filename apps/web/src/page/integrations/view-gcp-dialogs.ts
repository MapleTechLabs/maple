import type { V2GcpConnector } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { GCP_SCOPE_NAMES, gcpScopeLabel } from "../../components/integrations/gcp-connector-state"
import { gcpRemovalList } from "../../components/integrations/gcp-setup-steps"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import * as DialogView from "../../ui/dialog-view"
import { icon } from "../../ui/icon"
import { relativeTime } from "../kit/relative-time"
import { IAC_DOCS } from "./gcp-configure-copy"
import { Message } from "./message"
import type { Model } from "./model"
import { gcpConnectors, neverReported } from "./update-gcp"
import { openCloudShellButton, type ScriptFailure, SMALL, scriptBlock, step } from "./view-gcp-parts"
import { removalItem } from "./view-gcp-setup-methods"

// `GcpDisconnectDialog`, and the `ConfirmDialog`s of `GcpConnection` and `GcpIntegrationCard`.

type H = HtmlBuilder<Message>

const toDialog = (message: Parameters<typeof Message.GotGcpDisconnectDialogMessage>[0]["message"]) =>
	Message.GotGcpDisconnectDialogMessage({ message })

/** Nothing reported: the delete alone, with what it leaves behind. */
const quietDisconnect = (h: H, model: Model, connector: V2GcpConnector): Html =>
	confirmDialog(h, {
		slotId: "gcp-disconnect",
		model: model.gcpCard.disconnectDialog,
		toParentMessage: toDialog,
		title: `Disconnect ${gcpScopeLabel(connector)}?`,
		confirmLabel: "Disconnect",
		onConfirm: Message.ConfirmedGcpDisconnect(),
		isPending: model.gcpCard.isDisconnecting,
		children: [
			h.dl(
				[h.Class("flex flex-col gap-3 pb-3 text-sm")],
				[
					h.div(
						[],
						[
							h.dt([h.Class("font-medium")], ["In Maple"]),
							h.dd([h.Class("text-pretty text-muted-foreground")], ["Removes the connection."]),
						],
					),
					h.div(
						[],
						[
							h.dt([h.Class("font-medium")], ["In Google Cloud"]),
							h.dd(
								[h.Class("text-pretty text-muted-foreground")],
								[
									"Maple hasn't seen a setup finish or any data arrive. If you created anything, in the console or as code, delete it there. Maple also offers the cleanup script afterwards, which removes it however it was made.",
								],
							),
						],
					),
				],
			),
		],
	})

const scriptFailure = (model: Model): ScriptFailure | null => {
	const data = model.gcpCard.scripts.data
	if (AsyncData.isFailure(data)) return { message: data.error.message, isRetrying: false }
	return null
}

const settledScript = (model: Model): string | null => {
	const data = model.gcpCard.scripts.data
	return AsyncData.isSuccess(data) ? data.data.cleanup_script : null
}

/** What the cleanup deletes: only the capabilities a run may have set up. */
const deletesText = (connector: V2GcpConnector): string =>
	`${[
		connector.applied_logs_enabled === false
			? null
			: "the log sink, subscription, topic and push service account",
		connector.applied_metrics_enabled === false ? null : "the read-only service account and its roles",
	]
		.filter((part) => part !== null)
		.join(", and ")
		.replace(/^./, (first) => first.toUpperCase())}.`

/** `GcpDisconnectDialog`: the cleanup script first, then the disconnect. */
const cleanupDisconnect = (h: H, model: Model, connector: V2GcpConnector, timeZone: string): Html => {
	const card = model.gcpCard
	const cleaned = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
	const id = card.disconnectDialog.id
	const busy = card.isDisconnecting
	return h.submodel({
		slotId: "gcp-disconnect",
		model: card.disconnectDialog,
		view: DialogView.view,
		toParentMessage: toDialog,
		viewInputs: {
			hasTrigger: false,
			className: "sm:max-w-2xl",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(
						h,
						"dialog",
						id,
						[
							`Disconnect ${GCP_SCOPE_NAMES[connector.scope_type]}`,
							" ",
							h.span([h.Class("whitespace-nowrap")], [connector.scope_id]),
						],
						"pr-8",
					),
				]),
				DialogView.dialogPanel(h, "dialog", id, [
					h.ol(
						[],
						[
							step(
								h,
								{
									number: 1,
									state: cleaned ? "done" : "current",
									title: "Remove Maple's resources from Google Cloud",
									detail:
										cleaned && connector.setup_reported_at !== null
											? [
													relativeTime(h, {
														value: connector.setup_reported_at,
														nowMs: model.nowMs,
														timeZone,
														prefix: "Cleaned up",
													}),
													".",
												]
											: [
													`Run the cleanup script in Cloud Shell, about ${connector.applied_logs_enabled === true ? "two minutes" : "a minute"}, or delete them in the console below. Set up with Terraform or Alchemy? `,
													h.a(
														[
															h.Href(`${IAC_DOCS}#change-or-remove`),
															h.Target("_blank"),
															h.Rel("noreferrer"),
															h.Class("underline"),
														],
														["Destroy it there"],
													),
													", then disconnect.",
												],
								},
								cleaned
									? []
									: [
											h.dl(
												[h.Class("grid grid-cols-[auto_1fr] gap-x-3 text-xs/5")],
												[
													h.dt([h.Class("text-foreground")], ["Deletes"]),
													h.dd(
														[h.Class("text-pretty text-muted-foreground")],
														[deletesText(connector)],
													),
													h.dt([h.Class("text-foreground")], ["Keeps"]),
													h.dd(
														[h.Class("text-muted-foreground")],
														["The APIs it switched on."],
													),
												],
											),
											scriptBlock(
												h,
												model,
												{
													id: "disconnect-cleanup",
													script: settledScript(model),
													label: "cleanup script",
													failure: scriptFailure(model),
												},
												[openCloudShellButton(h, connector.project_id)],
											),
											h.details(
												[h.Class("text-xs/5")],
												[
													h.summary(
														[h.Class("cursor-pointer text-foreground")],
														["Delete them in the console instead"],
													),
													h.ol(
														[
															h.Class(
																"mt-2 flex list-decimal flex-col gap-2 pl-5",
															),
														],
														gcpRemovalList(connector, "all").map((item) =>
															removalItem(h, model, item),
														),
													),
												],
											),
											h.p(
												[h.Class(cn(SMALL, "text-foreground/80"))],
												[
													connector.setup_reported_at === null
														? "Maple sees the cleanup script finish. Removed them another way? Disconnect anyway."
														: "Waiting for the cleanup script. This updates on its own.",
												],
											),
										],
							),
							step(
								h,
								{
									number: 2,
									state: cleaned ? "current" : "pending",
									title: "Disconnect from Maple",
									detail: [
										"Maple stops accepting this connection's logs and reading its metrics. Data already in Maple is kept.",
									],
								},
								[],
							),
						],
					),
					...(cleaned
						? []
						: [
								h.p(
									[h.Class(cn(SMALL, "mt-4 flex items-start gap-1.5 text-foreground"))],
									[
										icon(h, "AlertWarningIcon", {
											size: 12,
											className: "mt-1 shrink-0 text-severity-warn",
										}),
										connector.applied_logs_enabled === false
											? "If they're still there, disconnecting leaves the read-only service account in Google Cloud."
											: "If they're still there, disconnecting leaves Google Cloud publishing logs to Pub/Sub, billed by Google.",
									],
								),
							]),
				]),
				DialogView.dialogFooter(h, "dialog", [
					button(
						h,
						{
							variant: "outline",
							isDisabled: busy,
							slot: "dialog-close",
							attributes: busy ? [] : close,
						},
						["Cancel"],
					),
					button(
						h,
						{
							variant: cleaned ? "destructive" : "destructive-outline",
							isLoading: busy,
							attributes: [h.OnClick(Message.ConfirmedGcpDisconnect())],
						},
						[cleaned ? "Disconnect" : "Disconnect anyway"],
					),
				]),
			],
		},
	})
}

const disconnectDialog = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const connector = gcpConnectors(model).find((entry) => entry.id === model.gcpCard.disconnectId)
	if (connector === undefined) return []
	return [
		neverReported(connector)
			? quietDisconnect(h, model, connector)
			: cleanupDisconnect(h, model, connector, timeZone),
	]
}

const dismissDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "gcp-dismiss-cleanup",
		model: model.gcpCard.dismissDialog,
		toParentMessage: (message) => Message.GotGcpDismissDialogMessage({ message }),
		title: "Dismiss the cleanup script?",
		description:
			"Dismiss it once the cleanup has run. Maple keeps the script only here, so it can't be shown again.",
		tone: "default",
		hasIcon: false,
		confirmLabel: "Dismiss",
		onConfirm: Message.ConfirmedDismissCleanup(),
	})

export const gcpDialogs = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => [
	...disconnectDialog(h, model, timeZone),
	dismissDialog(h, model),
]
