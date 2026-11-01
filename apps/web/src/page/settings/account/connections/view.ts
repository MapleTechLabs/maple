import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import { badge } from "../../../../ui/display"
import { icon } from "../../../../ui/icon"
import { settingRow } from "../../../../ui/setting-row"
import { accountSectionSkeleton } from "../../kit/account-skeleton"
import { settingsSection, settingsSections } from "../../kit/section"
import type { AccountUser } from "../user"
import { Message, type Model } from "./model"
import { PROVIDERS, providerOf } from "./update"

type H = HtmlBuilder<Message>

const providerRow = (h: H, model: Model, user: AccountUser, provider: (typeof PROVIDERS)[number]): Html => {
	const account = user.externalAccounts.find((entry) => entry.provider === provider.id)
	const isBusy = model.busy === provider.id
	const ids = {
		control: `connection-${provider.id}`,
		label: `connection-${provider.id}-label`,
		description: `connection-${provider.id}-description`,
	}
	return settingRow(h, {
		ids,
		className: "p-4",
		icon: h.div([h.Class("text-muted-foreground")], [icon(h, provider.icon, { size: 18 })]),
		label: h.span(
			[h.Class("flex items-center gap-1.5")],
			[
				provider.label,
				...(account !== undefined && !account.isVerified
					? [badge(h, { variant: "outline", className: "text-muted-foreground" }, ["Incomplete"])]
					: []),
			],
		),
		description: h.span(
			[h.Class("block truncate")],
			[
				account === undefined
					? `Connect your ${provider.label} account`
					: account.emailAddress || account.username || "Connected",
			],
		),
		control:
			account === undefined
				? [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								isLoading: isBusy,
								attributes: [h.OnClick(Message.ClickedConnect({ provider: provider.id }))],
							},
							["Connect"],
						),
					]
				: [
						...(account.isVerified
							? []
							: [
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											isDisabled: isBusy,
											attributes: [
												h.OnClick(
													Message.ClickedRetry({
														provider: provider.id,
														accountId: account.id,
													}),
												),
											],
										},
										["Retry"],
									),
								]),
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								isDisabled: isBusy,
								attributes: [
									h.OnClick(
										Message.ClickedDisconnect({
											provider: provider.id,
											accountId: account.id,
										}),
									),
								],
							},
							["Disconnect"],
						),
					],
	})
}

const loaded = (h: H, model: Model, user: AccountUser): Html => {
	const label = model.removing === null ? undefined : providerOf(model.removing.provider).label
	return settingsSections(h, [
		settingsSection(
			h,
			{
				id: "account-connections",
				title: "Connected accounts",
				description: [
					"Sign in to Maple with a provider you already use. Disconnecting one removes it as a sign-in method.",
				],
				padded: false,
			},
			[
				h.div(
					[h.Class("divide-y")],
					PROVIDERS.map((provider) => providerRow(h, model, user, provider)),
				),
			],
		),
		confirmDialog(h, {
			slotId: "account-disconnect",
			model: model.removeDialog,
			toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
			title: `Disconnect ${label}?`,
			description: `You will no longer be able to sign in to Maple with ${label}. Make sure you still have a password, a passkey or another connected account first.`,
			confirmLabel: "Disconnect",
			isPending: model.busy !== null,
			onConfirm: Message.ClickedConfirmDisconnect(),
		}),
	])
}

export const view = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>(
	(model, _inputs, h) =>
		!model.isLoaded || model.user === null ? accountSectionSkeleton(h) : loaded(h, model, model.user),
)
