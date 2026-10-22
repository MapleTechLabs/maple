import type { CloudflareIntegrationStatus } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../infra-integrations/kit/integration-empty"
import { CLOUDFLARE_ACCENT } from "./catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { cloudflareConnected } from "./view-cloudflare-connected"

// `CloudflareAccountCard` and `CloudflareHeaderActions`.

type H = HtmlBuilder<Message>

const BRAND = {
	icon: "CloudflareBrandIcon",
	backerIcon: "CloudflareMonoIcon",
	accent: CLOUDFLARE_ACCENT,
} as const

const notConnected = (h: H, model: Model): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Zone analytics",
				title: "Requests & cache per zone",
				description: "Traffic, cache hit rate, and errors for every zone under Infrastructure.",
			},
			{
				label: "Workers",
				title: "Scripts on the service map",
				description:
					"Every Worker appears as a node with request volume and errors wired into traces.",
			},
			{
				label: "DNS & security",
				title: "Firewall events with context",
				description: "DNS records, hosts, and WAF activity land alongside your traces and logs.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, ["Your zones and Workers will appear here after connecting."]),
			button(
				h,
				{
					isDisabled: model.connect.isStarting,
					isLoading: model.connect.isStarting,
					attributes: [h.OnClick(Message.ClickedConnect())],
				},
				[icon(h, "CloudflareBrandIcon"), "Connect Cloudflare"],
			),
			integrationEmptyFooter(h, ["Read-only OAuth · takes about a minute · disconnect anytime"]),
		]),
	])

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
	status.connected ? cloudflareConnected(h, model, status, timeZone) : notConnected(h, model)

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

/** Reconnect, or Edit accounts while the grant covers several. */
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
		[isMultiAccount(model) ? "Edit accounts" : "Reconnect"],
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
