import { PreviewSignInRequest } from "@maple/domain/http"
import { Duration, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { modifyFields } from "foldkit/struct"
import { MapleApiClient } from "../../platform/api-clients"
import type { Resources } from "../../platform/resources"
import { endpointMessage } from "./request"

// Clerk-mode `/sign-in`: Clerk's card, and on PR previews the access-key form that buys a sign-in ticket for
// the shared reviewer (`PreviewAccessForm`).

export const Preview = Schema.Literals(["Checking", "Disabled", "Enabled"])
export type Preview = typeof Preview.Type

export const Model = Schema.TaggedStruct("ClerkSignIn", {
	/** `validateInternalRedirect(redirect_url)`: Clerk's `forceRedirectUrl`. */
	target: Schema.NullOr(Schema.String),
	preview: Preview,
	accessKey: Schema.String,
	isKeyFocused: Schema.Boolean,
	isKeyTouched: Schema.Boolean,
	isSubmitting: Schema.Boolean,
	errorMessage: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CheckedPreviewSignIn: { isEnabled: Schema.Boolean },
	UpdatedAccessKey: { value: Schema.String },
	FocusedAccessKey: {},
	BlurredAccessKey: {},
	SubmittedPreviewSignIn: {},
	SucceededRequestPreviewTicket: { ticket: Schema.String },
	FailedRequestPreviewTicket: { message: Schema.String },
	CompletedOpenTicketSignIn: {},
})
export type Message = typeof Message.Type

// COMMANDS

/** `loadPreviewSignInEnabled`: true only on PR previews; any failure or a 3 s timeout is false. */
export const CheckPreviewSignIn = Command.define("CheckPreviewSignIn", {
	messages: [Message.CheckedPreviewSignIn],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiClient
		const status = yield* client.authPublic.previewSignInStatus()
		return Message.CheckedPreviewSignIn({ isEnabled: status.enabled === true })
	}).pipe(
		Effect.timeout(Duration.seconds(3)),
		Effect.orElseSucceed(() => Message.CheckedPreviewSignIn({ isEnabled: false })),
	),
})

/** `requestPreviewTicket`: `POST /api/auth/preview/sign-in` with the access key. */
export const RequestPreviewTicket = Command.define("RequestPreviewTicket", {
	args: { key: Schema.String },
	messages: [Message.SucceededRequestPreviewTicket, Message.FailedRequestPreviewTicket],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			const result = yield* client.authPublic.previewSignIn({
				payload: new PreviewSignInRequest({ key }),
			})
			return Message.SucceededRequestPreviewTicket({ ticket: result.ticket })
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedRequestPreviewTicket({
						message: endpointMessage(error, "Preview sign-in failed"),
					}),
				),
			),
		),
})

/** `openTicketSignIn`: reload `/sign-in` with the ticket, which Clerk's card redeems on mount. */
export const OpenTicketSignIn = Command.define("OpenTicketSignIn", {
	args: { ticket: Schema.String, target: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedOpenTicketSignIn],
	execute: ({ ticket, target }) => {
		const params = new URLSearchParams({ __clerk_ticket: ticket })
		if (target !== null) params.set("redirect_url", target)
		return load(`/sign-in?${params.toString()}`).pipe(Effect.as(Message.CompletedOpenTicketSignIn()))
	},
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Resources>

/** The route loader's preview probe runs before the page renders. */
export const init = (target: string | null): UpdateReturn => ({
	model: {
		_tag: "ClerkSignIn",
		target,
		preview: "Checking",
		accessKey: "",
		isKeyFocused: false,
		isKeyTouched: false,
		isSubmitting: false,
		errorMessage: null,
	},
	commands: [CheckPreviewSignIn()],
})

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CheckedPreviewSignIn: ({ isEnabled }) => ({
			model: modifyFields(model, { preview: () => (isEnabled ? "Enabled" : "Disabled") }),
		}),
		UpdatedAccessKey: ({ value }) => ({ model: modifyFields(model, { accessKey: () => value }) }),
		FocusedAccessKey: () => ({ model: modifyFields(model, { isKeyFocused: () => true }) }),
		BlurredAccessKey: () => ({
			model: modifyFields(model, { isKeyFocused: () => false, isKeyTouched: () => true }),
		}),
		SubmittedPreviewSignIn: () =>
			model.isSubmitting
				? { model }
				: {
						model: modifyFields(model, { isSubmitting: () => true, errorMessage: () => null }),
						commands: [RequestPreviewTicket({ key: model.accessKey.trim() })],
					},
		SucceededRequestPreviewTicket: ({ ticket }) => ({
			model,
			commands: [OpenTicketSignIn({ ticket, target: model.target })],
		}),
		FailedRequestPreviewTicket: ({ message: failure }) => ({
			model: modifyFields(model, { isSubmitting: () => false, errorMessage: () => failure }),
		}),
		CompletedOpenTicketSignIn: () => ({ model: modifyFields(model, { isSubmitting: () => false }) }),
	})
