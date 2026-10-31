import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { label } from "../../ui/label"
import * as OtpField from "../../ui/otp-field"
import { authDescription, authLayout, authTitle } from "./auth-layout"
import { CODE_FIELD_ID, CODE_LABEL_ID, Message, type Model, type DeviceInfo } from "./cli-login"

type H = HtmlBuilder<Message>

const otpConfig = (model: Model): OtpField.OtpFieldViewConfig<Message> => ({
	model: model.otp,
	toParentMessage: (message) => Message.GotOtpMessage({ message }),
	labelledBy: CODE_LABEL_ID,
	isInvalid: model.state._tag === "Failed",
	size: "lg",
})

/** The code entry: `<Label>`, the eight-slot `<OTPField>` and its hint, then the error. */
const entry = (h: H, model: Model): Html => {
	const config = otpConfig(model)
	const slot = (index: number) =>
		OtpField.otpFieldInput(h, config, index, undefined, index === 0 ? [] : [h.AriaLabel(`Character ${index + 1} of 8`)])
	return h.div(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("space-y-1.5")],
				[
					label(h, { attributes: [h.For(CODE_FIELD_ID), h.Id(CODE_LABEL_ID)] }, ["One-time code"]),
					...OtpField.otpField(h, config, [
						slot(0),
						slot(1),
						slot(2),
						slot(3),
						OtpField.otpFieldSeparator(h),
						slot(4),
						slot(5),
						slot(6),
						slot(7),
					]),
					h.p([h.Class("text-xs text-muted-foreground")], ["Enter the eight-character code shown in your terminal."]),
				],
			),
			...(model.state._tag === "Failed"
				? [h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [model.state.message])]
				: []),
		],
	)
}

const ready = (h: H, info: DeviceInfo, workspace: Html): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			h.div(
				[h.Class("space-y-1 border border-border bg-surface-sunken p-3")],
				[
					h.p([h.Class("text-xs text-muted-foreground")], ["Requesting device"]),
					h.p(
						[h.Class("line-clamp-2 font-medium [overflow-wrap:anywhere]"), h.Title(info.deviceName)],
						[info.deviceName],
					),
					h.p([h.Class("font-mono text-sm text-muted-foreground")], [info.userCode]),
					h.p([h.Class("text-xs text-muted-foreground")], ["Expires at ", info.expiresAtLabel]),
				],
			),
			workspace,
			h.p(
				[h.Class("text-sm text-muted-foreground")],
				["The CLI will receive a revocable credential with your current workspace role."],
			),
			h.div(
				[h.Class("flex gap-2")],
				[
					button(
						h,
						{
							variant: "outline",
							className: "flex-1",
							attributes: [h.OnClick(Message.ClickedDecision({ action: "deny" }))],
						},
						["Deny"],
					),
					button(
						h,
						{ className: "flex-1", attributes: [h.OnClick(Message.ClickedDecision({ action: "approve" }))] },
						["Approve"],
					),
				],
			),
		],
	)

const outcome = (h: H, title: string, detail: string): Html =>
	h.div(
		[h.Class("py-6 text-center"), h.Role("status")],
		[h.p([h.Class("font-medium")], [title]), h.p([h.Class("mt-1 text-sm text-muted-foreground")], [detail])],
	)

const stateView = (h: H, model: Model, workspace: Html): ReadonlyArray<Html> => {
	switch (model.state._tag) {
		case "Entry":
		case "Failed":
			return [entry(h, model)]
		case "Loading":
			return [
				h.p([h.Role("status"), h.Class("py-8 text-center text-sm text-muted-foreground")], ["Checking authorization…"]),
			]
		case "Ready":
			return [ready(h, model.state.info, workspace)]
		case "Approved":
			return [outcome(h, "CLI access approved", "You can close this tab and return to your terminal.")]
		case "Denied":
			return [outcome(h, "CLI access denied", "No credential was created.")]
	}
}

export const view = (h: H, model: Model, workspace: Html): Html =>
	authLayout(h, "max-w-md", [
		h.div(
			[h.Class("space-y-5")],
			[
				h.div(
					[],
					[
						authTitle(h, ["Authorize Maple CLI"]),
						authDescription(h, ["Approve a terminal session without copying an API key."]),
					],
				),
				...stateView(h, model, workspace),
			],
		),
	])
