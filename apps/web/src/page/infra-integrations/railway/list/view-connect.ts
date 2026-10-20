import { RailwayConnectRequest } from "@maple/domain/http"
import { Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import * as Field from "../../../../ui/field"
import { icon } from "../../../../ui/icon"
import { input } from "../../../../ui/input"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
	RAILWAY_ACCENT,
} from "../../kit/integration-empty"
import { Message } from "./message"
import type { ConnectForm } from "./model"

// `RailwayIntegrationCard`'s not-connected branch and `RailwayTokenForm` in connect mode.

/** The form's Messages, so the infra page and the integration card share it. */
export type TokenFormConfig<M> = Readonly<{
	mode: "connect" | "rotate"
	onField: (message: Field.Message) => M
	onSubmit: M
	onCancel?: M
}>

export const LIST_TOKEN_FORM: TokenFormConfig<Message> = {
	mode: "connect",
	onField: (message) => Message.GotTokenFieldMessage({ message }),
	onSubmit: Message.SubmittedConnect(),
}

const TOKENS_URL = "https://railway.com/account/tokens"
const LABEL_ID = "railway-token-label"
const ERROR_ID = "railway-token-error"
const DESCRIPTION_ID = "railway-token-description"

const decodeConnectRequest = Schema.decodeUnknownOption(RailwayConnectRequest)

/** `RailwayTokenForm`: connect, or rotate with an optional Cancel. */
export const railwayTokenForm = <M>(
	h: HtmlBuilder<M>,
	form: ConnectForm,
	config: TokenFormConfig<M>,
): Html => {
	const trimmed = form.token.value.trim()
	const isValid = Option.isSome(decodeConnectRequest({ token: trimmed }))
	const isTokenInvalid = trimmed.length > 0 && !isValid
	const hasError = !form.isSubmitting && form.error !== null
	const base: Field.FieldIds = { control: "railway-token", label: LABEL_ID, error: ERROR_ID }
	const showsDescription = isTokenInvalid && !form.isSubmitting && form.error === null
	const ids: Field.FieldIds = showsDescription ? { ...base, description: DESCRIPTION_ID } : base
	const state = Field.stateOf(form.token, hasError)
	const note: ReadonlyArray<Html> = form.isSubmitting
		? [
				h.p(
					[h.Class("text-xs text-muted-foreground"), h.AriaLive("polite")],
					["Checking the token and pulling the last hour of metrics. This takes a few seconds."],
				),
			]
		: form.error !== null
			? [Field.fieldError(h, { ids, state, attributes: [h.Role("alert")] }, form.error)]
			: isTokenInvalid
				? [
						Field.fieldDescription(
							h,
							{ ids, state },
							"A Railway token is between 8 and 512 characters.",
						),
					]
				: []
	return h.form(
		[h.Class("flex w-full flex-col gap-2 text-left"), h.OnSubmit(config.onSubmit)],
		[
			Field.field(h, { className: "items-stretch gap-2", state }, [
				Field.fieldLabel(h, { ids, state }, "Account or workspace token"),
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						input(h, {
							id: ids.control,
							type: "password",
							className: "min-w-48 flex-1",
							fieldState: state,
							attributes: [
								h.Autocomplete("off"),
								h.Placeholder("Paste a Railway API token"),
								...Field.controlAttributes(h, form.token, config.onField),
								h.AriaLabelledBy(LABEL_ID),
								...(hasError ? [h.AriaInvalid(true)] : []),
							],
						}),
						...(config.onCancel === undefined
							? []
							: [
									button(
										h,
										{
											variant: "outline",
											isDisabled: form.isSubmitting,
											attributes: [h.OnClick(config.onCancel)],
										},
										["Cancel"],
									),
								]),
						button(h, { type: "submit", isDisabled: !isValid, isLoading: form.isSubmitting }, [
							icon(h, "RailwayIcon"),
							config.mode === "rotate" ? "Update token" : "Connect Railway",
						]),
					],
				),
				...note,
			]),
		],
	)
}

const FEATURES = [
	{
		label: "Resources",
		title: "CPU and memory per replica",
		description: "Usage against limits for every service, sampled each minute.",
	},
	{
		label: "Network & disk",
		title: "Traffic and volumes",
		description: "Network in and out, volume and ephemeral disk usage.",
	},
	{
		label: "Correlation",
		title: "Next to your traces",
		description: "Metrics carry the Railway service name, so they line up with your telemetry.",
	},
]

const BRAND = { icon: "RailwayIcon", accent: RAILWAY_ACCENT, iconClassName: "text-foreground" } as const

export const railwayConnectCard = <M>(
	h: HtmlBuilder<M>,
	form: ConnectForm,
	config: TokenFormConfig<M>,
): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, FEATURES),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, [
				"Connecting pulls the last hour of metrics right away, then Maple keeps it fresh every 5 minutes.",
			]),
			railwayTokenForm(h, form, config),
			integrationEmptyFooter(h, [
				h.a(
					[
						h.Class(
							"inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline",
						),
						h.Href(TOKENS_URL),
						h.Target("_blank"),
						h.Rel("noreferrer"),
					],
					["Create a token in Railway ", icon(h, "ExternalLinkIcon", { size: 12 })],
				),
				". A workspace token limits Maple to one workspace. PR environments are skipped.",
			]),
		]),
	])
