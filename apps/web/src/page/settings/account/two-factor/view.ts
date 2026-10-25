import { REPLAY_BLOCK_CLASS } from "../../../../components/common/replay-privacy"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import * as CopyButton from "../../../../ui/copy-button"
import { copyableField } from "../../../../ui/copyable-field"
import * as DialogView from "../../../../ui/dialog-view"
import { badge } from "../../../../ui/display"
import { icon } from "../../../../ui/icon"
import * as OtpField from "../../../../ui/otp-field"
import { accountSectionSkeleton } from "../../kit/account-skeleton"
import { settingsSection, settingsSections } from "../../kit/section"
import { codeField } from "../code-field"
import type { AccountUser } from "../user"
import { type EnrollStep, Message, type Model } from "./model"
import { qrCode } from "./qr-code"

type H = HtmlBuilder<Message>

const authenticatorSection = (h: H, model: Model, user: AccountUser): Html =>
	settingsSection(
		h,
		{
			id: "account-totp",
			title: "Authenticator app",
			description: [
				"Require a six-digit code from an authenticator app (1Password, Authy, Google Authenticator) in addition to your password when you sign in.",
			],
			actions: user.totpEnabled
				? badge(h, { variant: "outline", className: "gap-1" }, [
						icon(h, "CircleCheckIcon", { size: 12 }),
						"Enabled",
					])
				: badge(h, { variant: "outline", className: "text-muted-foreground" }, ["Not set up"]),
		},
		[
			user.totpEnabled
				? h.div(
						[h.Class("flex items-center justify-between gap-4")],
						[
							h.p(
								[h.Class("text-xs text-muted-foreground")],
								["Your authenticator app is registered for this account."],
							),
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									isDisabled: model.isBusy,
									attributes: [h.OnClick(Message.ClickedRemove())],
								},
								["Remove"],
							),
						],
					)
				: button(
						h,
						{
							size: "sm",
							className: "self-start",
							isLoading: model.isBusy,
							attributes: [h.OnClick(Message.ClickedSetUp())],
						},
						[
							icon(h, "ShieldIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
							"Set up authenticator",
						],
					),
		],
	)

const backupSection = (h: H, model: Model, user: AccountUser): ReadonlyArray<Html> =>
	user.totpEnabled
		? [
				settingsSection(
					h,
					{
						id: "account-backup-codes",
						title: "Backup codes",
						description: [
							"Single-use codes for signing in when you cannot reach your authenticator. Generating a new set invalidates the old one.",
						],
						...(user.backupCodeEnabled && {
							actions: badge(h, { variant: "secondary" }, ["Active"]),
						}),
					},
					[
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								className: "self-start",
								isLoading: model.isBusy,
								attributes: [h.OnClick(Message.ClickedRegenerate())],
							},
							[user.backupCodeEnabled ? "Regenerate codes" : "Generate codes"],
						),
					],
				),
			]
		: []

const header = (h: H, id: string, title: string, description: string): Html =>
	DialogView.dialogHeader(h, "dialog", [
		DialogView.dialogTitle(h, "dialog", id, title),
		DialogView.dialogDescription(h, "dialog", id, description),
	])

const stepContent = (h: H, model: Model, step: EnrollStep): ReadonlyArray<Html> => {
	const id = model.enrollDialog.id
	switch (step._tag) {
		case "Scan":
			return [
				header(
					h,
					id,
					"Scan this code",
					"Open your authenticator app and scan the code, or enter the setup key by hand.",
				),
				DialogView.dialogPanel(h, "dialog", id, [
					h.div(
						[h.Class("flex flex-col items-center gap-4")],
						[
							h.div(
								[h.Class("rounded-md border border-border bg-background p-3")],
								[qrCode(h, step.uri, "size-44")],
							),
							h.div(
								[h.Class("w-full")],
								[
									copyableField(h, {
										id: "account-totp-secret",
										value: step.secret,
										label: "Setup key",
										copyLabel: "Setup key",
										copy: model.secretCopy,
										toCopyMessage: (message) => Message.GotSecretCopyMessage({ message }),
									}),
								],
							),
						],
					),
				]),
				DialogView.dialogFooter(h, "dialog", [
					button(
						h,
						{ variant: "outline", attributes: [h.OnClick(Message.ClickedCancelEnroll())] },
						["Cancel"],
					),
					button(h, { attributes: [h.OnClick(Message.ClickedContinue())] }, ["Continue"]),
				]),
			]
		case "Verify":
			return [
				header(
					h,
					id,
					"Enter the code",
					"Type the six-digit code your authenticator app is showing now.",
				),
				DialogView.dialogPanel(h, "dialog", id, [
					codeField(h, {
						model: model.code,
						label: "Authenticator code",
						toParentMessage: (message) => Message.GotCodeMessage({ message }),
					}),
				]),
				DialogView.dialogFooter(h, "dialog", [
					button(
						h,
						{
							variant: "outline",
							isDisabled: model.isBusy,
							attributes: [h.OnClick(Message.ClickedBack())],
						},
						["Back"],
					),
					button(
						h,
						{
							isLoading: model.isBusy,
							isDisabled: OtpField.valueOf(model.code).length < 6,
							attributes: [h.OnClick(Message.ClickedVerify())],
						},
						["Verify"],
					),
				]),
			]
		case "Codes":
			return [
				header(
					h,
					id,
					"Save your backup codes",
					"Each code works once. This is the only time they are shown, so store them somewhere safe before closing.",
				),
				DialogView.dialogPanel(h, "dialog", id, [
					h.div(
						[
							h.Class(
								"grid grid-cols-2 gap-1.5 rounded-md border border-border bg-muted/30 p-3 font-mono text-xs",
							),
						],
						step.codes.map((code) => h.span([h.Key(code)], [code])),
					),
				]),
				DialogView.dialogFooter(h, "dialog", [
					CopyButton.view(h, {
						model: model.codesCopy,
						toParentMessage: (message) => Message.GotCodesCopyMessage({ message }),
						value: step.codes.join("\n"),
						label: "Backup codes",
						idleLabel: "Copy all",
						variant: "outline",
					}),
					button(h, { attributes: [h.OnClick(Message.ClickedSavedCodes())] }, ["I saved them"]),
				]),
			]
	}
}

/** Every step shows a secret in plain text, and the dashboard records itself: the dialog is blocked. */
const enrollDialog = (h: H, model: Model): Html =>
	h.submodel({
		slotId: "account-totp-enroll",
		model: model.enrollDialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotEnrollDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			className: REPLAY_BLOCK_CLASS,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => (model.enroll === null ? [] : stepContent(h, model, model.enroll)),
		},
	})

const loaded = (h: H, model: Model, user: AccountUser): Html =>
	settingsSections(h, [
		authenticatorSection(h, model, user),
		...backupSection(h, model, user),
		enrollDialog(h, model),
		confirmDialog(h, {
			slotId: "account-totp-disable",
			model: model.disableDialog,
			toParentMessage: (message) => Message.GotDisableDialogMessage({ message }),
			title: "Remove two-factor authentication?",
			description:
				"Your account will be protected by your password alone, and your backup codes stop working.",
			confirmLabel: "Remove",
			isPending: model.isBusy,
			onConfirm: Message.ClickedConfirmRemove(),
		}),
	])

export const view = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>(
	(model, _inputs, h) =>
		!model.isLoaded || model.user === null ? accountSectionSkeleton(h) : loaded(h, model, model.user),
)
