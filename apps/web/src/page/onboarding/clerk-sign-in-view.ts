import type { Html, HtmlBuilder } from "foldkit/html"
import { accountLayout } from "../../layout/account-layout"
import { button } from "../../ui/button"
import { field, fieldError, fieldLabel, type FieldIds, type FieldState, input } from "../../ui/field"
import { clerkCard } from "./clerk-card"
import { Message as ClerkSignInMessage, type Model } from "./clerk-sign-in"
import type { Message } from "./index"

type H = HtmlBuilder<Message>
type Wrap = (message: ClerkSignInMessage) => Message

const KEY_FIELD: FieldIds = {
	control: "preview-access-key",
	label: "preview-access-key-label",
	error: "preview-access-key-error",
}

/** `PreviewAccessForm`: the shared reviewer's access key, traded for a Clerk sign-in ticket. */
const previewAccessForm = (h: H, model: Model, wrap: Wrap): Html => {
	const state: FieldState = {
		isInvalid: model.errorMessage !== null,
		isDirty: model.accessKey !== "",
		isFilled: model.accessKey !== "",
		isFocused: model.isKeyFocused,
		isTouched: model.isKeyTouched,
	}
	return h.form(
		[
			h.Class("mt-8 space-y-4 border-t border-border pt-6"),
			h.OnSubmit(wrap(ClerkSignInMessage.SubmittedPreviewSignIn())),
		],
		[
			h.div(
				[h.Class("space-y-1")],
				[
					h.p([h.Class("font-mono text-xs tracking-[0.02em]")], ["PR preview"]),
					h.p(
						[h.Class("font-display text-muted-foreground text-sm leading-relaxed")],
						["Sign in as the shared preview reviewer with the preview access key."],
					),
				],
			),
			field(h, { className: "items-stretch", state }, [
				fieldLabel(
					h,
					{ ids: KEY_FIELD, className: "font-mono text-xs sm:text-xs tracking-[0.02em]", state },
					"Access key",
				),
				input(h, {
					ids: KEY_FIELD,
					state,
					attributes: [
						h.Autocomplete("off"),
						h.Required(true),
						h.Type("password"),
						h.Value(model.accessKey),
						h.Disabled(model.isSubmitting),
						h.OnInput((value) => wrap(ClerkSignInMessage.UpdatedAccessKey({ value }))),
						h.OnFocus(wrap(ClerkSignInMessage.FocusedAccessKey())),
						h.OnBlur(wrap(ClerkSignInMessage.BlurredAccessKey())),
					],
				}),
				...(model.errorMessage === null
					? []
					: [
							fieldError(
								h,
								{
									ids: KEY_FIELD,
									className: "font-mono",
									state,
									attributes: [h.Role("alert")],
								},
								model.errorMessage,
							),
						]),
			]),
			button(
				h,
				{ type: "submit", variant: "outline", className: "w-full", isLoading: model.isSubmitting },
				["Sign in to preview"],
			),
		],
	)
}

/** Nothing renders until the route loader's preview probe answers. */
export const view = (h: H, model: Model, wrap: Wrap): Html =>
	model.preview === "Checking"
		? h.empty
		: accountLayout(h, [
				clerkCard(h, "SignIn", model.target),
				...(model.preview === "Enabled" ? [previewAccessForm(h, model, wrap)] : []),
			])
