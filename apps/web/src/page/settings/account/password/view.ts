import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { fieldError } from "../../../../ui/field"
import { accountSectionSkeleton } from "../../kit/account-skeleton"
import { settingsSection, settingsSections } from "../../kit/section"
import { switchRow } from "../../kit/switch-row"
import { fieldIds, stateFor, textField } from "../fields"
import { Message, type Model, type PasswordField } from "./model"
import { canSubmit, hasPasswordOf, isMismatch, isTooShort, MIN_PASSWORD_LENGTH } from "./update"

type H = HtmlBuilder<Message>

const passwordField = (
	h: H,
	model: Model,
	options: Readonly<{
		field: PasswordField
		id: string
		label: string
		autoComplete: string
		/** `aria-invalid` is written as `"false"` when valid too, which Base UI's styles read. */
		invalid?: Readonly<{ isInvalid: boolean; error: string | ReadonlyArray<string> }>
	}>,
): Html => {
	const value = model[options.field]
	const isInvalid = options.invalid?.isInvalid ?? false
	return textField(h, {
		id: options.id,
		label: options.label,
		value,
		type: "password",
		autoComplete: options.autoComplete,
		isDisabled: model.isSaving,
		isInvalid,
		onInput: (next) => Message.ChangedPassword({ field: options.field, value: next }),
		attributes: options.invalid !== undefined && !isInvalid ? [h.AriaInvalid(false)] : [],
		after:
			options.invalid !== undefined && isInvalid
				? [fieldError(h, { ids: fieldIds(options.id), state: stateFor(value, true) }, options.invalid.error)]
				: [],
	})
}

const loaded = (h: H, model: Model): Html => {
	const hasPassword = hasPasswordOf(model)
	return settingsSections(h, "standard", [
		settingsSection(
			h,
			{
				id: "account-password",
				title: hasPassword ? "Change password" : "Set a password",
				description: [
					hasPassword
						? "Use at least 8 characters. Changing your password can sign you out of your other devices."
						: "You signed up with a social account or an email code. Adding a password gives you a second way in.",
				],
			},
			[
				h.div(
					[h.Class("space-y-4 max-w-md")],
					[
						...(hasPassword
							? [
									passwordField(h, model, {
										field: "current",
										id: "account-current-password",
										label: "Current password",
										autoComplete: "current-password",
									}),
								]
							: []),
						passwordField(h, model, {
							field: "next",
							id: "account-new-password",
							label: "New password",
							autoComplete: "new-password",
							invalid: { isInvalid: isTooShort(model), error: ["Use at least ", String(MIN_PASSWORD_LENGTH), " characters."] },
						}),
						passwordField(h, model, {
							field: "confirm",
							id: "account-confirm-password",
							label: "Confirm new password",
							autoComplete: "new-password",
							invalid: { isInvalid: isMismatch(model), error: "Passwords do not match." },
						}),
						switchRow(h, {
							id: "account-sign-out-others",
							framed: true,
							label: "Sign out of other devices",
							description: "End every session except this one.",
							isChecked: model.isSigningOutOthers,
							isDisabled: model.isSaving,
							onToggle: Message.ToggledSignOutOthers(),
						}),
						h.div(
							[h.Class("flex justify-end")],
							[
								button(
									h,
									{
										size: "sm",
										isLoading: model.isSaving,
										isDisabled: !canSubmit(model),
										attributes: [h.OnClick(Message.ClickedSubmit())],
									},
									[hasPassword ? "Change password" : "Set password"],
								),
							],
						),
					],
				),
			],
		),
	])
}

export const view = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>((model, _inputs, h) =>
	!model.isLoaded || model.user === null ? accountSectionSkeleton(h) : loaded(h, model),
)
