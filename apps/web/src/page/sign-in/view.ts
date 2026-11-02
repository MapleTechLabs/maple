import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accountLayout } from "../../layout/account-layout"
import { button } from "../../ui/button"
import { heading } from "../../ui/heading"
import { field, fieldError, fieldLabel, input, type FieldIds, type FieldState } from "../../ui/field"
import { Message, type Model, SignInFailure, Submission } from "./sign-in"

// NOTE: fixed ids for the password field. Base UI's `dirty` compares with the initial value, which is
// always empty here.
const PASSWORD_FIELD: FieldIds = { control: "base-ui-_r_0_", label: "base-ui-_r_1_", error: "base-ui-_r_5_" }

/** The API's message, or the browser's fetch failure text. */
const failureMessage = (failure: SignInFailure): string =>
	SignInFailure.match(failure, {
		Rejected: ({ message }) => message,
		Unreachable: () => "Failed to fetch",
		Unexpected: () => "Invalid root password",
	})

const maybeFailureOf = (submission: Submission): Option.Option<SignInFailure> =>
	Submission.match(submission, {
		NotSubmitted: () => Option.none(),
		Submitting: () => Option.none(),
		Failed: ({ failure }) => Option.some(failure),
	})

const passwordField = (model: Model, h: HtmlBuilder<Message>): Html => {
	const maybeFailure = maybeFailureOf(model.submission)
	const isSubmitting = model.submission._tag === "Submitting"
	const state: FieldState = {
		isInvalid: Option.isSome(maybeFailure),
		isDirty: model.password !== "",
		isFilled: model.password !== "",
		isFocused: model.isPasswordFocused,
		isTouched: model.isPasswordTouched,
	}
	return field(h, { className: "items-stretch", state }, [
		fieldLabel(
			h,
			{ ids: PASSWORD_FIELD, className: "font-mono text-xs sm:text-xs tracking-wide", state },
			"Root password",
		),
		input(h, {
			ids: PASSWORD_FIELD,
			state,
			attributes: [
				h.Autocomplete("current-password"),
				h.Required(true),
				h.Type("password"),
				h.Value(model.password),
				h.Disabled(isSubmitting),
				h.OnInput((value) => Message.UpdatedPassword({ value })),
				h.OnFocus(Message.FocusedPassword()),
				h.OnBlur(Message.BlurredPassword()),
			],
		}),
		...Option.match(maybeFailure, {
			onNone: () => [],
			onSome: (failure) => [
				fieldError(
					h,
					{ ids: PASSWORD_FIELD, className: "font-mono", state, attributes: [h.Role("alert")] },
					failureMessage(failure),
				),
			],
		}),
	])
}

/** `SelfHostedSignInPage`. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
	accountLayout(h, [
		h.div(
			[h.Class("space-y-8")],
			[
				h.div(
					[h.Class("space-y-2")],
					[
						heading(h, { level: 1, variant: "display" }, ["Sign in to Maple"]),
						h.p(
							[h.Class("font-display text-muted-foreground text-sm leading-relaxed")],
							["This deployment is self-hosted. Enter the root password to continue."],
						),
					],
				),
				h.form(
					[h.Class("space-y-6"), h.OnSubmit(Message.SubmittedSignIn())],
					[
						passwordField(model, h),
						button(
							h,
							{
								type: "submit",
								className: "w-full",
								isLoading: model.submission._tag === "Submitting",
							},
							["Sign in"],
						),
					],
				),
			],
		),
	]),
)
