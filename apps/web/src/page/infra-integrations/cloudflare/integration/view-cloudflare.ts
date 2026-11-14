import type { CloudflareIntegrationStatus } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route/index"
import { button, linkButton } from "@maple/views/ui/button"
import { skeletonBlock } from "@maple/views/ui/skeleton"
import { integrationNotice } from "../../../integrations/kit/notice"
import { Message } from "../../../integrations/message"
import type { Model } from "../../../integrations/model"
import { cloudflareConnected } from "./view-cloudflare-connected"
import { disconnectDialog } from "../../../integrations/view-disconnect"
import { integrationStatusCard } from "../../../integrations/view-integration-card"
import { hstack } from "@maple/views/ui/stack"

type H = HtmlBuilder<Message>

/** A source page whose grant was removed: the way back is the connect flow. */
const cloudflareReconnect = (h: H): Html =>
	integrationNotice(h, {
		message: "Cloudflare is not connected.",
		action: linkButton(
			h,
			{ size: "sm", href: hrefOf(AppRoute.SourcesNew({ search: { integration: "cloudflare" } })) },
			["Reconnect"],
		),
	})

export const cloudflareCard = (h: H, model: Model, timeZone: string): Html =>
	integrationStatusCard(h, model.statuses.cloudflare, {
		name: "cloudflare",
		failureTitle: "Couldn't load the Cloudflare integration",
		render: (status) => byStatus(h, model, status, timeZone),
		loading: () => skeletonBlock(h, { height: "40" }),
		stale: "failure",
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

/** Reconnect (or edit accounts) and disconnect, while connected. */
export const cloudflareHeaderActions = (h: H, model: Model): ReadonlyArray<Html> => {
	const multi = isMultiAccount(model)
	const busy = isBusy(model)
	return [
		hstack(h, { gap: "2" }, [
			cloudflareReconnectButton(h, model),
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					isDisabled: busy,
					isLoading: model.disconnect.isPending,
					attributes: [h.OnClick(Message.ClickedDisconnect())],
				},
				[multi ? "Disconnect all" : "Disconnect"],
			),
			disconnectDialog(h, model, multi ? "cloudflare-multi" : "cloudflare"),
		]),
	]
}
