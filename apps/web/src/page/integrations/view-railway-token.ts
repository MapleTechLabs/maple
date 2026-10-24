import { RailwayConnectRequest } from "@maple/domain/http"
import { Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as Field from "../../ui/field"
import { input } from "../../ui/input"
import { whereToFind } from "../kit/connect-flow"
import { Message } from "./message"
import type { RailwayCardModel } from "./railway"

// `RailwayTokenForm`: the connect flow's Connect step, and Update credential on the connected card.

type H = HtmlBuilder<Message>

const TOKENS_URL = "https://railway.com/account/tokens"
const LABEL_ID = "railway-token-label"
const ERROR_ID = "railway-token-error"
const DESCRIPTION_ID = "railway-token-description"

const decodeConnectRequest = Schema.decodeUnknownOption(RailwayConnectRequest)

export const railwayTokenForm = (
	h: H,
	form: RailwayCardModel["connect"],
	options: Readonly<{ mode: "connect" | "rotate"; canCancel: boolean }>,
): Html => {
	const trimmed = form.token.value.trim()
	const isValid = Option.isSome(decodeConnectRequest({ token: trimmed }))
	const isTokenInvalid = trimmed.length > 0 && !isValid
	const hasError = !form.isSubmitting && form.error !== null
	const base: Field.FieldIds = { control: "railway-token", label: LABEL_ID, error: ERROR_ID }
	const ids: Field.FieldIds = { ...base, description: DESCRIPTION_ID }
	const state = Field.stateOf(form.token, hasError)
	return h.form(
		[h.Class("flex w-full flex-col gap-4 text-left"), h.OnSubmit(Message.SubmittedRailwayToken())],
		[
			Field.field(h, { className: "items-stretch gap-2", state }, [
				h.div(
					[h.Class("flex items-center justify-between gap-2")],
					[
						Field.fieldLabel(h, { ids, state }, "Account or workspace token"),
						whereToFind(h, "Create a token in Railway", TOKENS_URL),
					],
				),
				input(h, {
					id: ids.control,
					type: "password",
					fieldState: state,
					attributes: [
						h.Autocomplete("off"),
						h.Placeholder("Paste a Railway API token"),
						...Field.controlAttributes(h, form.token, (message) =>
							Message.GotRailwayTokenMessage({ message }),
						),
						h.AriaLabelledBy(LABEL_ID),
						...(hasError ? [h.AriaInvalid(true)] : []),
					],
				}),
				hasError
					? Field.fieldError(h, { ids, state, attributes: [h.Role("alert")] }, form.error ?? "")
					: Field.fieldDescription(
							h,
							{ ids, state },
							isTokenInvalid
								? "A Railway token is between 8 and 512 characters."
								: "Project tokens only see one environment, so Maple asks for an account or workspace token.",
						),
			]),
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					button(h, { type: "submit", isDisabled: !isValid, isLoading: form.isSubmitting }, [
						options.mode === "rotate" ? "Update token" : "Check token",
					]),
					...(options.canCancel
						? [
								button(
									h,
									{
										variant: "outline",
										isDisabled: form.isSubmitting,
										attributes: [h.OnClick(Message.ClickedRailwayRotateCancel())],
									},
									["Cancel"],
								),
							]
						: []),
				],
			),
		],
	)
}
