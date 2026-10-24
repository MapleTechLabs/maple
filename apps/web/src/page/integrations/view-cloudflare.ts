import type { CloudflareIntegrationStatus } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import { errorState } from "../../ui/error-state"
import { skeleton } from "../../ui/skeleton"
import { Message } from "./message"
import type { Model } from "./model"
import { cloudflareConnected } from "./view-cloudflare-connected"

// `CloudflareAccountCard` and `CloudflareHeaderActions`.

type H = HtmlBuilder<Message>

/** A source page whose grant was removed: the way back is the connect flow. */
const cloudflareReconnect = (h: H): Html =>
	h.div(
		[
			h.Class(
				"flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 text-sm",
			),
		],
		[
			h.span([h.Class("text-muted-foreground")], ["Cloudflare is not connected."]),
			linkButton(
				h,
				{ size: "sm", href: hrefOf(AppRoute.SourcesNew({ search: { integration: "cloudflare" } })) },
				["Reconnect"],
			),
		],
	)

export const cloudflareCard = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.statuses.cloudflare.data, {
		onIdle: () => skeleton(h, "h-40 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-40 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Cloudflare integration",
				onRetry: Message.ClickedRetryStatus({ name: "cloudflare" }),
			}),
		onStale: ({ error }) =>
			errorState(h, {
				failure: error,
				title: "Failed to load the Cloudflare integration",
				onRetry: Message.ClickedRetryStatus({ name: "cloudflare" }),
			}),
		onRefreshing: (status) => byStatus(h, model, status, timeZone),
		onSuccess: (status) => byStatus(h, model, status, timeZone),
	})

const byStatus = (h: H, model: Model, status: CloudflareIntegrationStatus, timeZone: string): Html =>
	status.connected ? cloudflareConnected(h, model, status, timeZone) : cloudflareReconnect(h)

const accountCountOf = (model: Model): number =>
	AsyncData.match(model.statuses.cloudflare.data, {
		onIdle: () => 1,
		onLoading: () => 1,
		onFailure: () => 1,
		onStale: () => 1,
		onRefreshing: (status) => status.accounts?.length ?? (status.connected ? 1 : 0),
		onSuccess: (status) => status.accounts?.length ?? (status.connected ? 1 : 0),
	})

/** Whether the grant covers several accounts (labels the header actions and the confirmation). */
export const isMultiAccount = (model: Model): boolean => accountCountOf(model) > 1

const isBusy = (model: Model): boolean => model.connect.isStarting || model.disconnect.isPending

/** Reconnect: the consent screen again, where accounts are added or removed. */
export const cloudflareReconnectButton = (h: H, model: Model): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "outline",
			isDisabled: isBusy(model),
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		["Reconnect"],
	)

/** `CloudflareHeaderActions`: reconnect (or edit accounts) and disconnect, while connected. */
export const cloudflareHeaderActions = (h: H, model: Model): ReadonlyArray<Html> => {
	const multi = isMultiAccount(model)
	const busy = isBusy(model)
	return [
		h.div(
			[h.Class("flex items-center gap-2")],
			[
				cloudflareReconnectButton(h, model),
				button(
					h,
					{
						size: "sm",
						variant: "destructive-outline",
						isDisabled: busy,
						isLoading: model.disconnect.isPending,
						attributes: [h.OnClick(Message.ClickedDisconnect())],
					},
					[multi ? "Disconnect all" : "Disconnect"],
				),
				confirmDialog(h, {
					slotId: "integration-disconnect",
					model: model.disconnect.dialog,
					toParentMessage: (message) => Message.GotDisconnectDialogMessage({ message }),
					title: "Disconnect Cloudflare",
					description: multi
						? "Maple stops collecting data from all connected Cloudflare accounts. You can reconnect later."
						: "Maple stops collecting data from this Cloudflare account. You can reconnect later.",
					confirmLabel: "Disconnect",
					onConfirm: Message.ConfirmedDisconnect(),
				}),
			],
		),
	]
}
